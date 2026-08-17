// Sidebar 知识图谱面板
// 从旧 sidebar.js 迁移而来，使用 Canvas + d3-force 风格力导向布局
import { records, tags, markTags } from './state';

// ===== 类型定义 =====
export interface ForceGraphNode {
  id: string;
  type: 'record' | 'tag';
  label: string;
  text?: string;
  color: string;
  url?: string;
  connections: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  radius?: number;
  pinned?: boolean;
  [key: string]: any;
}

export interface ForceGraphEdge {
  source: string | ForceGraphNode;
  target: string | ForceGraphNode;
}

// ===== 状态 =====
let graphInitialized = false;
let graphEngine: ForceGraph | null = null;

// ===== 工具函数 =====
function escapeHtml(text: string): string {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (date.toDateString() === now.toDateString()) return '今天';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

// ===== 力导向图谱引擎 =====
class ForceGraph {
  canvas: HTMLCanvasElement;
  wrapper: HTMLElement;
  tooltipEl: HTMLElement | null;
  ctx: CanvasRenderingContext2D;
  nodes: ForceGraphNode[] = [];
  edges: ForceGraphEdge[] = [];
  animId: number | null = null;
  running = false;
  _needsRender = false;
  width = 0;
  height = 0;

  // 视图状态
  viewX = 0;
  viewY = 0;
  viewScale = 1;

  // 交互状态
  draggedNode: ForceGraphNode | null = null;
  dragOffX = 0;
  dragOffY = 0;
  isPanning = false;
  panStartX = 0;
  panStartY = 0;
  viewStartX = 0;
  viewStartY = 0;
  hoveredNode: ForceGraphNode | null = null;
  focusNodeIds: Set<string> = new Set();
  focusAnimTime = 0;
  /** 定位时跳过位置重置，保持节点当前位置 */
  _skipPositionReset = false;

  // 物理参数
  repulsion = 6000;
  attraction = 0.003;
  damping = 0.85; 
  minVelocity = 0.3;
  centerForce = 0.008;

  // 回调
  onNodeClick: ((node: ForceGraphNode) => void) | null = null;
  onHoverTooltip: ((node: ForceGraphNode) => string) | null = null;

  // 缓存
  _cachedColors: Record<string, string> = {};
  _themeObserver: MutationObserver | null = null;

  // 点击检测
  _clickTime = 0;
  _clickPos = { x: 0, y: 0 };
  _pinchDist = 0;
  _pinchScale = 1;

  constructor(canvas: HTMLCanvasElement, wrapper: HTMLElement, tooltipEl: HTMLElement | null) {
    this.canvas = canvas;
    this.wrapper = wrapper;
    this.tooltipEl = tooltipEl;
    this.ctx = canvas.getContext('2d')!;
    this._updateColorCache();
    this._resize();
    this._bindEvents();

    // ResizeObserver 响应容器尺寸变化
    const ro = new ResizeObserver(() => {
      this._resize();
      this._needsRender = true;
    });
    ro.observe(wrapper);

    // 观察主题变化
    this._themeObserver = new MutationObserver(() => {
      this._updateColorCache();
      this._needsRender = true;
      this._render();
    });
    this._themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  }

  _updateColorCache(): void {
    const style = getComputedStyle(this.wrapper);
    this._cachedColors = {
      bgSurface: style.getPropertyValue('--bg-surface').trim() || '#ffffff',
      border: style.getPropertyValue('--border').trim() || '#e5e7eb',
      isDark: document.documentElement.getAttribute('data-theme') === 'dark' ? 'true' : '',
    };
  }

  setData(nodes: ForceGraphNode[], edges: ForceGraphEdge[], resetPositions = false): void {
    // 需要重置时不清空 posMap，所有节点重新随机
    const posMap = new Map<string, { x: number; y: number; pinned: boolean }>();
    if (!resetPositions || this._skipPositionReset) {
      this.nodes.forEach(n => posMap.set(n.id, { x: n.x || 0, y: n.y || 0, pinned: n.pinned || false }));
    }
    this._skipPositionReset = false;

    this.nodes = nodes.map((n, i) => {
      const prev = posMap.get(n.id);
      const radius = Math.max(10, Math.min(24, 8 + Math.sqrt(n.connections || 0) * 4));
      // 重置时从中心聚集出发，产生直线飞行效果；保留旧位置时不改变
      let x: number, y: number;
      if (prev) {
        x = prev.x;
        y = prev.y;
      } else {
        // 全部从中心附近出发，产生直线飞行效果
        x = (Math.random() - 0.5) * 40;
        y = (Math.random() - 0.5) * 40;
      }

      return {
        ...n,
        x, y,
        vx: 0, vy: 0,
        radius,
        pinned: prev ? prev.pinned : false,
      };
    });

    const nodeIndex: Record<string, ForceGraphNode> = {};
    this.nodes.forEach(n => { nodeIndex[n.id] = n; });

    this.edges = edges.map(e => ({
      source: nodeIndex[typeof e.source === 'string' ? e.source : e.source.id],
      target: nodeIndex[typeof e.target === 'string' ? e.target : e.target.id],
    })).filter(e => e.source && e.target);

    if (this.running) this.start();
    else { this._needsRender = true; this._render(); }
  }

  start(): void {
    this.running = true;
    if (!this.animId) this._tick();
  }

  stop(): void {
    this.running = false;
    if (this.animId) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
  }

  destroy(): void {
    this.stop();
    if (this._themeObserver) this._themeObserver.disconnect();
  }

  _tick(): void {
    if (!this.running) return;

    // 物理模拟
    const nodes = this.nodes;
    const len = nodes.length;

    // 库仑斥力
    for (let i = 0; i < len; i++) {
      for (let j = i + 1; j < len; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x! - a.x!;
        let dy = b.y! - a.y!;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = this.repulsion / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (!a.pinned) { a.vx! -= fx; a.vy! -= fy; }
        if (!b.pinned) { b.vx! += fx; b.vy! += fy; }
      }
    }

    // 胡克引力（沿边）
    const dragBoost = this.draggedNode ? 8 : 1;
    this.edges.forEach(e => {
      if (!e.source || !e.target) return;
      const src = e.source as ForceGraphNode;
      const tgt = e.target as ForceGraphNode;
      const dx = tgt.x! - src.x!;
      const dy = tgt.y! - src.y!;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      let force = (dist - 100) * this.attraction * dragBoost;
      if (dragBoost > 1) force = Math.max(-3, Math.min(3, force));
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (!src.pinned) { src.vx! += fx; src.vy! += fy; }
      if (!tgt.pinned) { tgt.vx! -= fx; tgt.vy! -= fy; }
    });

    // 向心力
    nodes.forEach(n => {
      if (n.pinned) return;
      n.vx! += (0 - n.x!) * this.centerForce;
      n.vy! += (0 - n.y!) * this.centerForce;
    });

    // 更新位置 + 阻尼
    let totalEnergy = 0;
    nodes.forEach(n => {
      if (n.pinned) return;
      n.vx! *= this.damping;
      n.vy! *= this.damping;
      n.x! += n.vx!;
      n.y! += n.vy!;
      totalEnergy += n.vx! * n.vx! + n.vy! * n.vy!;
    });

    this._needsRender = true;

    // 定位脉冲动画衰减
    if (this.focusAnimTime > 0) {
      this.focusAnimTime -= 16;
      if (this.focusAnimTime <= 0) { this.focusAnimTime = 0; this.focusNodeIds.clear(); }
      this._needsRender = true;
    }

    // 动画继续条件：拖动中 / 能量高 / 脉冲动画中
    const hasDrag = this.draggedNode !== null;
    const hasFocus = this.focusAnimTime > 0;
    const isStable = (totalEnergy / len) < this.minVelocity * this.minVelocity;

    if (!hasDrag && !hasFocus && isStable) {
      this.running = false;
      this.animId = null;
      this._render();
      return;
    }

    this._render();
    this.animId = requestAnimationFrame(() => this._tick());
  }

  _resize(): void {
    const rect = this.wrapper.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.width = rect.width;
    this.height = rect.height;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._needsRender = true;
    if (this.nodes.length > 0 && !this.running) this._render();
  }

  _toWorld(sx: number, sy: number): { x: number; y: number } {
    const cx = this.width / 2;
    const cy = this.height / 2;
    return {
      x: (sx - cx) / this.viewScale - this.viewX,
      y: (sy - cy) / this.viewScale - this.viewY,
    };
  }

  _toScreen(wx: number, wy: number): { x: number; y: number } {
    const cx = this.width / 2;
    const cy = this.height / 2;
    return {
      x: (wx + this.viewX) * this.viewScale + cx,
      y: (wy + this.viewY) * this.viewScale + cy,
    };
  }

  _render(): void {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const c = this._cachedColors;

    // 清空
    ctx.clearRect(0, 0, w, h);

    // 背景
    ctx.fillStyle = c.bgSurface;
    ctx.fillRect(0, 0, w, h);

    // 缩放/平移变换
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(this.viewScale, this.viewScale);
    ctx.translate(this.viewX, this.viewY);

    // 画边
    const activeNode = this.draggedNode || this.hoveredNode;
    const glowColor = c.isDark ? '#4ade80' : '#16a34a';
    // 计算与 activeNode 相连的节点集合
    const connectedSet = new Set<string>();
    if (activeNode) {
      this.edges.forEach(e => {
        const src = e.source as ForceGraphNode;
        const tgt = e.target as ForceGraphNode;
        if (src === activeNode) connectedSet.add(tgt.id);
        if (tgt === activeNode) connectedSet.add(src.id);
      });
      connectedSet.add(activeNode.id);
    }
    this.edges.forEach(e => {
      const src = e.source as ForceGraphNode;
      const tgt = e.target as ForceGraphNode;
      if (!src || !tgt) return;
      const isConnected = (src === activeNode || tgt === activeNode);
      ctx.beginPath();
      ctx.moveTo(src.x!, src.y!);
      ctx.lineTo(tgt.x!, tgt.y!);
      if (isConnected) {
        ctx.strokeStyle = glowColor;
        ctx.lineWidth = 0.5;
        ctx.globalAlpha = 0.85;
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = 10;
      } else if (activeNode) {
        ctx.strokeStyle = c.isDark ? '#ffffff' : '#000000';
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.12;
        ctx.shadowBlur = 0;
      } else {
        ctx.strokeStyle = c.isDark ? '#ffffff' : '#000000';
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.5;
        ctx.shadowBlur = 0;
      }
      ctx.stroke();
    });
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    // 画节点
    const textColor = c.isDark ? '#d0d0d0' : '#1f2937';
    const textDim = c.isDark ? '#555555' : '#cccccc';

    this.nodes.forEach(n => {
      const r = n.radius! * (this.viewScale < 0.6 ? 0.7 : 1);
      const isFocused = activeNode && (n === activeNode || connectedSet.has(n.id));

      ctx.beginPath();
      ctx.arc(n.x!, n.y!, r, 0, Math.PI * 2);

      if (n.type === 'tag') {
        ctx.fillStyle = n.color;
        ctx.globalAlpha = isFocused || !activeNode ? 0.15 : 0.04;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = n.color;
        ctx.lineWidth = isFocused || !activeNode ? 2 : 1;
        ctx.globalAlpha = isFocused || !activeNode ? 1 : 0.2;
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = n.color || '#3b82f6';
        ctx.globalAlpha = isFocused || !activeNode ? 0.9 : 0.15;
        ctx.fill();
        ctx.globalAlpha = 1;
        if (n === this.hoveredNode) {
          ctx.shadowColor = n.color;
          ctx.shadowBlur = 12;
          ctx.strokeStyle = n.color;
          ctx.lineWidth = 2.5;
          ctx.stroke();
          ctx.shadowBlur = 0;
        } else if (n === this.draggedNode) {
          ctx.shadowColor = n.color;
          ctx.shadowBlur = 14;
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.shadowBlur = 0;
        } else if ((n as any)._searchMatch) {
          // 搜索匹配高亮：蓝色外圈
          ctx.strokeStyle = '#60a5fa';
          ctx.lineWidth = 2;
          ctx.shadowColor = '#60a5fa';
          ctx.shadowBlur = 10;
          ctx.stroke();
          ctx.shadowBlur = 0;
        }
      }
    });

    // 标签
    if (this.viewScale > 0.4) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      this.nodes.forEach(n => {
        const r = n.radius! * (this.viewScale < 0.6 ? 0.7 : 1);
        const label = n.label && n.label.length > 10 ? n.label.substring(0, 10) + '…' : (n.label || '');
        ctx.font = `500 ${Math.max(10, 11 * this.viewScale)}px sans-serif`;
        const isFocused = activeNode && (n === activeNode || connectedSet.has(n.id));
        ctx.fillStyle = isFocused || !activeNode ? textColor : textDim;
        ctx.globalAlpha = isFocused || !activeNode ? 1 : 0.3;
        ctx.fillText(label, n.x!, n.y! + r + 4);
        ctx.globalAlpha = 1;
      });
    }

    ctx.restore();
    this._needsRender = false;

    // 定位指示器（画在 restore 之后，用屏幕坐标，始终可见）
    if (this.focusNodeIds.size > 0 && this.focusAnimTime > 0) {
      const p = Math.min(1, this.focusAnimTime / 3000);        // 0→1 衰减
      const pulse = Math.sin(this.focusAnimTime * 0.008) * 0.3 + 0.7; // 0.4~1.0 呼吸
      this.focusNodeIds.forEach(nid => {
        const fn = this.nodes.find(n => n.id === nid);
        if (!fn) return;
        const { x: sx, y: sy } = this._worldToScreen(fn.x!, fn.y!);
        const sr = fn.radius! * this.viewScale;

        ctx.save();
        ctx.globalAlpha = pulse * 0.25;
        ctx.fillStyle = '#ffdd00';
        ctx.beginPath();
        ctx.arc(sx, sy, sr + 20 + (1 - p) * 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // 外圈呼吸光环
        ctx.save();
        ctx.globalAlpha = Math.max(0.3, pulse * p);
        ctx.strokeStyle = '#ffdd00';
        ctx.lineWidth = 3;
        ctx.shadowColor = '#ffdd00';
        ctx.shadowBlur = 18;
        ctx.beginPath();
        ctx.arc(sx, sy, sr + 8 + (1 - p) * 12, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      });
    }
  }

  // 将世界坐标转为屏幕坐标（使用 getBoundingClientRect）
  _worldToScreen(wx: number, wy: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    return {
      x: (wx + this.viewX) * this.viewScale + cx,
      y: (wy + this.viewY) * this.viewScale + cy,
    };
  }

  focusOnNodes(nodeIds: string[]): void {
    if (nodeIds.length === 0) return;
    // 收集所有节点的位置，计算包围盒
    const pts = nodeIds.map(id => this.nodes.find(n => n.id === id)).filter(Boolean) as ForceGraphNode[];
    if (pts.length === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    pts.forEach(n => {
      if (n.x! < minX) minX = n.x!;
      if (n.x! > maxX) maxX = n.x!;
      if (n.y! < minY) minY = n.y!;
      if (n.y! > maxY) maxY = n.y!;
    });
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    const pad = 80;
    const scale = Math.min(
      (this.width - pad * 2) / (rangeX + pad),
      (this.height - pad * 2) / (rangeY + pad),
      2.0
    );
    this.viewScale = Math.max(0.2, scale);
    this.viewX = -cx;
    this.viewY = -cy;
    this.focusNodeIds = new Set(nodeIds);
    this.focusAnimTime = 3000;
    this._needsRender = true;
    if (!this.running) { this.running = true; this._tick(); }
    else { this._render(); }
  }

  focusOnNode(nodeId: string): void {
    const node = this.nodes.find(n => n.id === nodeId);
    if (!node) return;
    // 基于当前缩放级别适度放大，而不是硬编码 1.5
    const targetScale = Math.max(0.6, Math.min(1.5, this.viewScale * 2.5));
    this.viewScale = targetScale;
    this.viewX = -(node.x || 0);
    this.viewY = -(node.y || 0);
    this.focusNodeIds = new Set([nodeId]);
    this.focusAnimTime = 3000; // 3 秒脉冲动画
    this._needsRender = true;
    if (!this.running) { this.running = true; this._tick(); }
    else { this._render(); }
  }

  resetView(): void {
    // 停止物理模拟
    if (this.animId) { cancelAnimationFrame(this.animId); this.animId = null; }
    this.running = false;
    this.viewX = 0;
    this.viewY = 0;
    this.viewScale = 1;
    this._needsRender = true;
    this._render();
  }

  fitToScreen(): void {
    if (this.nodes.length === 0) return;
    const pad = 60;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      const nx = n.x || 0, ny = n.y || 0;
      if (nx < minX) minX = nx;
      if (ny < minY) minY = ny;
      if (nx > maxX) maxX = nx;
      if (ny > maxY) maxY = ny;
    }
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    const scale = Math.min(
      (this.width - pad * 2) / rangeX,
      (this.height - pad * 2) / rangeY,
      2.5
    );
    this.viewScale = Math.max(0.2, scale);
    this.viewX = -(minX + maxX) / 2;
    this.viewY = -(minY + maxY) / 2;
    this._needsRender = true;
    this._render();
  }

  /** 根据节点数量估算最终布局范围，设置初始视角（无跳变） */
  autoFitView(): void {
    const count = this.nodes.length;
    if (count === 0) return;
    // 估算力模拟稳定后的分布半径（基于物理参数：repulsion=6000, centerForce=0.008）
    // equilibrium: centerForce * R = N * repulsion / R² → R = cbrt(N * repulsion / centerForce)
    const estimatedRadius = Math.cbrt(count * 750000) * 1.5;
    const pad = 60;
    const targetScale = Math.min(
      (this.width - pad * 2) / (2 * estimatedRadius + pad),
      (this.height - pad * 2) / (2 * estimatedRadius + pad),
      1.0
    );
    this.viewScale = Math.max(0.15, targetScale);
    this.viewX = 0;
    this.viewY = 0;
    this._needsRender = true;
    this._render();
  }

  _bindEvents(): void {
    // 鼠标事件
    this.canvas.addEventListener('mousedown', e => this._onMouseDown(e));
    this.canvas.addEventListener('mousemove', e => this._onMouseMove(e));
    this.canvas.addEventListener('mouseup', e => this._onMouseUp(e));
    this.canvas.addEventListener('mouseleave', () => this._onMouseUp(null));
    this.canvas.addEventListener('wheel', e => this._onWheel(e), { passive: false });

    // 触摸事件
    this.canvas.addEventListener('touchstart', e => this._onTouchStart(e), { passive: false });
    this.canvas.addEventListener('touchmove', e => this._onTouchMove(e), { passive: false });
    this.canvas.addEventListener('touchend', e => this._onTouchEnd(e), { passive: false });

    // 点击（区分于拖拽）
    this._clickTime = 0;
    this._clickPos = { x: 0, y: 0 };
  }

  _getNodeAt(sx: number, sy: number): ForceGraphNode | null {
    const p = this._toWorld(sx, sy);
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      const dx = p.x - n.x!;
      const dy = p.y - n.y!;
      const r = n.radius! * (this.viewScale < 0.6 ? 0.7 : 1);
      if (dx * dx + dy * dy <= r * r + 4) return n;
    }
    return null;
  }

  _onMouseDown(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    this._clickPos = { x: sx, y: sy };
    this._clickTime = Date.now();

    const node = this._getNodeAt(sx, sy);
    if (node) {
      this.draggedNode = node;
      const p = this._toWorld(sx, sy);
      this.dragOffX = p.x - node.x!;
      this.dragOffY = p.y - node.y!;
      node.pinned = true;
      this._hideTooltip();
      this.start();
    } else {
      this.isPanning = true;
      this.panStartX = sx;
      this.panStartY = sy;
      this.viewStartX = this.viewX;
      this.viewStartY = this.viewY;
    }
  }

  _onMouseMove(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (this.draggedNode) {
      const p = this._toWorld(sx, sy);
      this.draggedNode.x = p.x - this.dragOffX;
      this.draggedNode.y = p.y - this.dragOffY;
      // 动画循环已在拖动时保持运行，标记重绘即可
      this._needsRender = true;
    } else if (this.isPanning) {
      const dx = (sx - this.panStartX) / this.viewScale;
      const dy = (sy - this.panStartY) / this.viewScale;
      this.viewX = this.viewStartX + dx;
      this.viewY = this.viewStartY + dy;
      this._needsRender = true;
      this._render();
    } else {
      // 悬停检测
      const node = this._getNodeAt(sx, sy);
      if (node !== this.hoveredNode) {
        this.hoveredNode = node;
        this.canvas.style.cursor = node ? 'pointer' : 'default';
        this._updateTooltip(node, e);
        this._render();
      }
    }
  }

  _updateTooltip(node: ForceGraphNode | null, e: MouseEvent): void {
    if (!this.tooltipEl) return;
    if (!node || !this.onHoverTooltip) {
      this.tooltipEl.classList.add('hidden');
      return;
    }
    const html = this.onHoverTooltip(node);
    if (!html) {
      this.tooltipEl.classList.add('hidden');
      return;
    }
    this.tooltipEl.innerHTML = html;
    this.tooltipEl.classList.remove('hidden');

    // 定位：鼠标相对 graph-panel 的位置
    const panel = this.tooltipEl.parentElement!;
    const prect = panel.getBoundingClientRect();
    let left = e.clientX - prect.left + 14;
    let top = e.clientY - prect.top - 10;

    // 防止溢出右侧
    const tw = this.tooltipEl.offsetWidth || 260;
    if (left + tw > prect.width - 8) {
      left = e.clientX - prect.left - tw - 14;
    }
    // 防止溢出底部
    const th = this.tooltipEl.offsetHeight || 200;
    if (top + th > prect.height - 8) {
      top = prect.height - th - 8;
    }
    // 防止溢出顶部
    if (top < 4) top = 4;

    this.tooltipEl.style.left = left + 'px';
    this.tooltipEl.style.top = top + 'px';
  }

  _hideTooltip(): void {
    if (this.tooltipEl) this.tooltipEl.classList.add('hidden');
  }

  _onMouseUp(e: MouseEvent | null): void {
    if (this.draggedNode) {
      const elapsed = Date.now() - this._clickTime;
      // 如果是快速点击（< 200ms）且没怎么移动，当作点击
      if (e && elapsed < 200) {
        const rect = this.canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const dist = Math.abs(sx - this._clickPos.x) + Math.abs(sy - this._clickPos.y);
        if (dist < 8 && this.onNodeClick && this.draggedNode) {
          this.onNodeClick(this.draggedNode);
        }
      }
      // 释放节点，恢复物理动效
      if (this.draggedNode) this.draggedNode.pinned = false;
      this.draggedNode = null;
    }
    this.isPanning = false;
  }

  _onWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    const delta = -e.deltaY * 0.001;
    const oldScale = this.viewScale;
    const newScale = Math.max(0.2, Math.min(3, this.viewScale + delta));

    // 以鼠标位置为中心缩放
    const cx = sx - this.width / 2;
    const cy = sy - this.height / 2;
    const wx = cx / oldScale - this.viewX;
    const wy = cy / oldScale - this.viewY;

    this.viewScale = newScale;
    this.viewX = cx / newScale - wx;
    this.viewY = cy / newScale - wy;

    this._render();
  }

  _onTouchStart(e: TouchEvent): void {
    e.preventDefault();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      this._onMouseDown({ clientX: t.clientX, clientY: t.clientY } as MouseEvent);
    } else if (e.touches.length === 2) {
      this._pinchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      this._pinchScale = this.viewScale;
    }
  }

  _onTouchMove(e: TouchEvent): void {
    e.preventDefault();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      this._onMouseMove({ clientX: t.clientX, clientY: t.clientY } as MouseEvent);
    } else if (e.touches.length === 2 && this._pinchDist) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      this.viewScale = Math.max(0.2, Math.min(3, this._pinchScale * (dist / this._pinchDist)));
      this._render();
    }
  }

  _onTouchEnd(e: TouchEvent): void {
    if (!e.touches || e.touches.length === 0) {
      this._onMouseUp(null);
    }
  }
}

// ===== 构建图谱数据 =====
function buildGraphData(): { nodes: ForceGraphNode[]; edges: ForceGraphEdge[] } {
  if (!records || records.length === 0) return { nodes: [], edges: [] };

  const nodeMap = new Map<string, ForceGraphNode>();
  const edgeSet = new Set<string>();
  const edges: ForceGraphEdge[] = [];

  // 1. 记录节点
  records.forEach((r: any) => {
    nodeMap.set(r.id, {
      id: r.id,
      type: 'record',
      label: r.title || (r.text ? r.text.substring(0, 28) : '未命名'),
      text: r.text,
      color: (r.color && r.color.bg) ? r.color.bg : '#3b82f6',
      url: r.url,
      connections: 0,
    });
  });

  // 2. 解析 [[链接]] 创建边
  records.forEach((r: any) => {
    if (!r.description) return;
    const matches = r.description.match(/\[\[([^\]]+)\]\]/g);
    if (!matches) return;

    matches.forEach((m: string) => {
      const name = m.slice(2, -2).trim().toLowerCase();
      const target = records.find((t: any) =>
        (t.title || '').toLowerCase() === name ||
        (t.text || '').substring(0, 60).toLowerCase().includes(name)
      );
      if (target && target.id !== r.id) {
        const key = [r.id, target.id].sort().join('|');
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({ source: r.id, target: target.id });
          const rNode = nodeMap.get(r.id);
          if (rNode) rNode.connections++;
          const tNode = nodeMap.get(target.id);
          if (tNode) tNode.connections++;
        }
      }
    });
  });

  // 3. 标签节点 + 记录↔标签边
  const tagNames = new Map<string, { id: string; label: string; connections: number }>();
  records.forEach((r: any) => {
    (r.tags || []).forEach((tag: string) => {
      if (!tagNames.has(tag)) {
        tagNames.set(tag, { id: 'tag_' + tag, label: tag, connections: 0 });
      }
      tagNames.get(tag)!.connections++;
    });
  });

  tagNames.forEach(tag => {
    nodeMap.set(tag.id, {
      id: tag.id,
      type: 'tag',
      label: tag.label,
      color: '#22c55e',
      connections: tag.connections,
    });
    records.forEach((r: any) => {
      if ((r.tags || []).includes(tag.label)) {
        const key = [r.id, tag.id].sort().join('|');
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({ source: r.id, target: tag.id });
        }
      }
    });
  });

  return { nodes: [...nodeMap.values()], edges };
}

// ===== 初始化图谱 UI =====
function initGraphUI(): void {
  if (graphInitialized) return;
  graphInitialized = true;

  const canvas = document.getElementById('graphCanvas') as HTMLCanvasElement;
  const wrapper = document.getElementById('graphWrapper') as HTMLElement;
  const tooltipEl = document.getElementById('graphTooltip') as HTMLElement | null;
  graphEngine = new ForceGraph(canvas, wrapper, tooltipEl);
  // 向后兼容：旧模块通过 window.__knowSeekGraphEngine 访问 engine
  (window as any).__knowSeekGraphEngine = graphEngine;

  graphEngine.onNodeClick = (node) => {
    if (node.type === 'record') {
      // 切换到全部标签页并定位到该标注
      const graphPanel = document.getElementById('graphPanel');
      const recordsList = document.getElementById('recordsList');
      const tagsPanel = document.getElementById('tagsPanel');
      const emptyState = document.getElementById('emptyState');
      if (graphPanel) graphPanel.classList.add('hidden');
      if (recordsList) recordsList.classList.remove('hidden');
      if (tagsPanel) tagsPanel.classList.remove('hidden');
      if (emptyState) emptyState.classList.add('hidden');

      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      const allTab = document.querySelector<HTMLElement>('.filter-tab[data-filter="all"]');
      if (allTab) allTab.classList.add('active');

      const searchInput = document.getElementById('searchInput') as HTMLInputElement | null;
      if (searchInput) searchInput.value = '';

      // 使用 records API
      const recordsApi = (window as any).__knowSeekRecords;
      if (recordsApi) {
        recordsApi.setFilter('all');
        // 展开树状路径（域名 → 路径 → 页面）
        const record = records.find((r: any) => r.id === node.id);
        if (record && typeof recordsApi.expandRecordTreePath === 'function') {
          recordsApi.expandRecordTreePath(record);
        }
        recordsApi.renderRecords();
        if (record) {
          setTimeout(() => {
            const card = recordsList?.querySelector(`[data-record-id="${node.id}"]`) as HTMLElement | null;
            if (card) {
              card.scrollIntoView({ behavior: 'smooth', block: 'center' });
              // 展开详情
              const detail = card.querySelector('.record-detail');
              if (detail) detail.classList.remove('hidden');
              // 高亮闪烁
              card.style.transition = 'background-color 0.3s';
              card.style.backgroundColor = '#eff6ff';
              setTimeout(() => {
                card.style.backgroundColor = '';
                card.style.transition = '';
              }, 1500);
            }
          }, 150);
        }
      }
    }
  };

  graphEngine.onHoverTooltip = (node) => {
    if (node.type === 'tag') return `
      <div class="tt-body">
        <strong>#${escapeHtml(node.label)}</strong>
        <div class="tt-meta" style="margin-top:4px">连接了 ${node.connections} 条标注</div>
      </div>`;
    if (node.type === 'record') {
      const record = records.find((r: any) => r.id === node.id);
      if (!record) return '';
      const color = record.color || { bg: '#fef08a', text: '#000000' };
      const recordTags = markTags.filter((mt: any) => mt.mark_id === record.id);
      const tagList = tags.filter((t: any) => recordTags.some((mt: any) => mt.tag_id === t.id));
      const tagHtml = tagList.map((t: any) => `<span class="tt-tag">${escapeHtml(t.name)}</span>`).join(' ');
      const desc = record.description || '';
      const date = formatDate(record.created_at);
      return `
        <div class="tt-highlight" style="background:${color.bg};color:${color.text}">${escapeHtml(record.text)}</div>
        <div class="tt-body">
          ${desc ? `<div class="tt-desc">${escapeHtml(desc)}</div>` : ''}
          <div class="tt-meta">
            <span>${date}</span>
            ${tagHtml ? '· ' + tagHtml : ''}
          </div>
          <div class="tt-meta" style="margin-top:4px">
            <span class="tt-url">${escapeHtml(record.page_title || record.url)}</span>
          </div>
        </div>`;
    }
    return '';
  };

  document.getElementById('graphRefreshBtn')?.addEventListener('click', () => {
    if (graphEngine) {
      const data = buildGraphData();
      graphEngine.setData(data.nodes, data.edges);
      graphEngine.start();
    }
  });

  document.getElementById('graphResetViewBtn')?.addEventListener('click', () => {
    if (graphEngine) graphEngine.resetView();
  });
}

// ===== 暴露到 window =====
const api = {
  initGraphUI,
  buildGraphData,
  get forceGraphEngine() { return graphEngine; },
};
(window as any).__knowSeekGraph = api;

export { ForceGraph, initGraphUI, buildGraphData };