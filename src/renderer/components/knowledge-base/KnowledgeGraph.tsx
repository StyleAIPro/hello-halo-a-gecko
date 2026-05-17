import { useEffect, useRef, useCallback } from 'react';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from 'd3-force';

interface GraphNode {
  id: string;
  title: string;
  type: string;
  tags: string[];
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
  vx?: number;
  vy?: number;
  index?: number;
}

interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
}

interface GraphData {
  nodes: Array<{ id: string; title: string; type: string; tags: string[] }>;
  links: Array<{ source: string; target: string }>;
}

const TYPE_COLORS: Record<string, string> = {
  concept: '#3b82f6',
  entity: '#22c55e',
  summary: '#a855f7',
  conversation: '#f59e0b',
};

const TYPE_LABELS: Record<string, string> = {
  concept: 'Concept',
  entity: 'Entity',
  summary: 'Summary',
  conversation: 'Conversation',
};

interface Props {
  data: GraphData;
  onNodeClick?: (nodeId: string) => void;
}

export function KnowledgeGraph({ data, onNodeClick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef<GraphNode[]>([]);
  const linksRef = useRef<GraphLink[]>([]);
  const simulationRef = useRef<ReturnType<typeof forceSimulation<GraphNode>> | null>(null);
  const hoveredRef = useRef<string | null>(null);
  const dragRef = useRef<{ node: GraphNode | null; startMouseX: number; startMouseY: number; moved: boolean }>({
    node: null,
    startMouseX: 0,
    startMouseY: 0,
    moved: false,
  });
  const transformRef = useRef({ x: 0, y: 0, scale: 1 });
  const panStartRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  const width = 800;
  const height = 500;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const { x: tx, y: ty, scale } = transformRef.current;
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(scale, scale);

    const nodes = nodesRef.current;
    const links = linksRef.current;
    const hovered = hoveredRef.current;

    // Draw links
    ctx.strokeStyle = 'rgba(155, 155, 155, 0.3)';
    ctx.lineWidth = 1;
    for (const link of links) {
      const source = link.source as GraphNode;
      const target = link.target as GraphNode;
      if (source.x == null || target.x == null) continue;
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      ctx.stroke();
    }

    // Compute connection counts for node sizing
    const connCount = new Map<string, number>();
    for (const link of links) {
      const sid = (link.source as GraphNode).id;
      const tid = (link.target as GraphNode).id;
      connCount.set(sid, (connCount.get(sid) ?? 0) + 1);
      connCount.set(tid, (connCount.get(tid) ?? 0) + 1);
    }

    // Draw nodes
    for (const node of nodes) {
      if (node.x == null) continue;
      const connections = connCount.get(node.id) ?? 0;
      const radius = Math.max(8, Math.min(20, 6 + connections * 2));
      const color = TYPE_COLORS[node.type] ?? '#6b7280';
      const isHovered = hovered === node.id;

      // Glow for hovered
      if (isHovered) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
      }

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x, node.y, isHovered ? radius + 3 : radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // Label
      ctx.fillStyle = isHovered ? '#ffffff' : '#d4d4d8';
      ctx.font = `${isHovered ? '12px' : '10px'} system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const label = node.title.length > 20 ? node.title.slice(0, 18) + '...' : node.title;
      ctx.fillText(label, node.x, node.y + (isHovered ? radius + 5 : radius + 3));
    }

    // Tooltip for hovered node
    if (hovered) {
      const node = nodes.find((n) => n.id === hovered);
      if (node && node.x != null) {
        const typeLabel = TYPE_LABELS[node.type] ?? node.type;
        const tagsStr = node.tags.length > 0 ? ` [${node.tags.slice(0, 5).join(', ')}]` : '';
        const text = `${node.title} (${typeLabel})${tagsStr}`;
        const padding = 8;
        ctx.font = '12px system-ui, sans-serif';
        const metrics = ctx.measureText(text);
        const tw = metrics.width + padding * 2;
        const th = 28;
        let tooltipX = node.x - tw / 2;
        let tooltipY = node.y - 40;

        ctx.fillStyle = 'rgba(24, 24, 27, 0.95)';
        ctx.beginPath();
        ctx.roundRect(tooltipX, tooltipY, tw, th, 6);
        ctx.fill();
        ctx.strokeStyle = 'rgba(63, 63, 70, 0.5)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#e4e4e7';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, node.x, tooltipY + th / 2);
      }
    }

    ctx.restore();
  }, [width, height]);

  const getNodeAt = useCallback((mouseX: number, mouseY: number): GraphNode | null => {
    const { x: tx, y: ty, scale } = transformRef.current;
    const worldX = (mouseX - tx) / scale;
    const worldY = (mouseY - ty) / scale;

    const connCount = new Map<string, number>();
    for (const link of linksRef.current) {
      const sid = (link.source as GraphNode).id;
      const tid = (link.target as GraphNode).id;
      connCount.set(sid, (connCount.get(sid) ?? 0) + 1);
      connCount.set(tid, (connCount.get(tid) ?? 0) + 1);
    }

    for (let i = nodesRef.current.length - 1; i >= 0; i--) {
      const node = nodesRef.current[i];
      if (node.x == null) continue;
      const connections = connCount.get(node.id) ?? 0;
      const radius = Math.max(8, Math.min(20, 6 + connections * 2));
      const dx = worldX - node.x;
      const dy = worldY - node.y;
      if (dx * dx + dy * dy <= (radius + 4) * (radius + 4)) {
        return node;
      }
    }
    return null;
  }, []);

  useEffect(() => {
    if (data.nodes.length === 0) return;

    const nodes: GraphNode[] = data.nodes.map((n) => ({ ...n, tags: n.tags ?? [] }));
    const links: GraphLink[] = data.links.map((l) => ({ ...l }));

    nodesRef.current = nodes;
    linksRef.current = links;

    const simulation = forceSimulation<GraphNode>(nodes)
      .force('link', forceLink<GraphNode, GraphLink>(links).id((d) => d.id).distance(80))
      .force('charge', forceManyBody().strength(-200))
      .force('center', forceCenter(width / 2, height / 2))
      .force('collide', forceCollide<GraphNode>().radius(20))
      .on('tick', draw);

    simulationRef.current = simulation;

    return () => {
      simulation.stop();
    };
  }, [data, draw, width, height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // Panning
      if (panStartRef.current) {
        const dx = e.clientX - panStartRef.current.x;
        const dy = e.clientY - panStartRef.current.y;
        transformRef.current.x = panStartRef.current.tx + dx;
        transformRef.current.y = panStartRef.current.ty + dy;
        draw();
        return;
      }

      // Dragging
      if (dragRef.current.node) {
        const dx = e.clientX - dragRef.current.startMouseX;
        const dy = e.clientY - dragRef.current.startMouseY;
        if (dx * dx + dy * dy > 9) {
          dragRef.current.moved = true;
        }
        const { x: tx, y: ty, scale } = transformRef.current;
        dragRef.current.node.fx = (mouseX - tx) / scale;
        dragRef.current.node.fy = (mouseY - ty) / scale;
        simulationRef.current?.alpha(0.3).restart();
        return;
      }

      // Hovering
      const node = getNodeAt(mouseX, mouseY);
      const newHovered = node?.id ?? null;
      if (newHovered !== hoveredRef.current) {
        hoveredRef.current = newHovered;
        canvas.style.cursor = newHovered ? 'pointer' : 'default';
        draw();
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      if (e.button === 0) {
        const node = getNodeAt(mouseX, mouseY);
        if (node) {
          dragRef.current = { node, startMouseX: e.clientX, startMouseY: e.clientY, moved: false };
          canvas.style.cursor = 'grabbing';
        } else {
          panStartRef.current = {
            x: e.clientX,
            y: e.clientY,
            tx: transformRef.current.x,
            ty: transformRef.current.y,
          };
        }
      }
    };

    const handleMouseUp = (_e: MouseEvent) => {
      if (dragRef.current.node) {
        const wasDrag = dragRef.current.moved;
        const clickedNode = dragRef.current.node;

        clickedNode.fx = null;
        clickedNode.fy = null;
        simulationRef.current?.alpha(0.3).restart();

        if (!wasDrag && onNodeClick) {
          onNodeClick(clickedNode.id);
        }

        dragRef.current = { node: null, startMouseX: 0, startMouseY: 0, moved: false };
        canvas.style.cursor = hoveredRef.current ? 'pointer' : 'default';
      }

      if (panStartRef.current) {
        panStartRef.current = null;
      }
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const newScale = Math.max(0.2, Math.min(5, transformRef.current.scale * factor));

      // Zoom towards mouse position
      transformRef.current.x = mouseX - (mouseX - transformRef.current.x) * (newScale / transformRef.current.scale);
      transformRef.current.y = mouseY - (mouseY - transformRef.current.y) * (newScale / transformRef.current.scale);
      transformRef.current.scale = newScale;
      draw();
    };

    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('mouseleave', handleMouseUp);
    canvas.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('mouseup', handleMouseUp);
      canvas.removeEventListener('mouseleave', handleMouseUp);
      canvas.removeEventListener('wheel', handleWheel);
    };
  }, [draw, getNodeAt, onNodeClick]);

  if (data.nodes.length === 0) {
    return (
      <div className="text-sm text-muted-foreground text-center py-12">
        No wiki pages to display
      </div>
    );
  }

  // Legend
  const typeSet = [...new Set(data.nodes.map((n) => n.type))];

  return (
    <div ref={containerRef} className="space-y-3">
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        {typeSet.map((type) => (
          <div key={type} className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: TYPE_COLORS[type] ?? '#6b7280' }} />
            <span>{TYPE_LABELS[type] ?? type}</span>
          </div>
        ))}
        <span className="ml-auto opacity-60">Scroll to zoom, drag to pan, click node to view</span>
      </div>
      <div className="border border-border rounded-lg overflow-hidden bg-background">
        <canvas
          ref={canvasRef}
          style={{ width, height }}
          className="w-full h-auto block"
        />
      </div>
    </div>
  );
}
