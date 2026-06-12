import {
  Background,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowLeft } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { SonosGroup } from "@misonos/sonos-protocol";
import { paletteForMembers } from "./groupPalette.js";

interface GroupEditorProps {
  groups: SonosGroup[];
  selectedGroupId?: string;
  busy?: boolean;
  onSelectGroup: (groupId: string) => void;
  onJoinZoneGroup: (zoneId: string, groupId: string) => void;
  onUngroupZone: (zoneId: string) => void;
  onPromoteZone: (zoneId: string) => void;
  onClose?: () => void;
}

type GroupNodeData = {
  kind: "group";
  groupId: string;
  label: string;
  color: string;
  selected: boolean;
};

type ZoneNodeData = {
  kind: "zone";
  zoneId: string;
  groupId?: string;
  label: string;
  color: string;
  coordinator: boolean;
};

type EditorNode = Node<GroupNodeData | ZoneNodeData>;

const CANVAS_PADDING_X = 12;
const CANVAS_TOP_RESERVED = 40;
const CANVAS_BOTTOM_RESERVED = 60;
const GROUP_GAP = 16;
const GROUP_LABEL_HEIGHT = 28;
const GROUP_INNER_PADDING = 22;
const ZONE_GAP = 10;
const ZONE_MIN_WIDTH = 64;
const ZONE_MIN_HEIGHT = 36;
const ZONE_MAX_WIDTH = 260;
const ZONE_MAX_HEIGHT = 120;
const FALLBACK_CANVAS_WIDTH = 800;
const FALLBACK_CANVAS_HEIGHT = 360;

interface Rect { x: number; y: number; w: number; h: number }

function sliceAndDice(weights: number[], rect: Rect, gap: number): Rect[] {
  const result: Rect[] = new Array(weights.length);
  const recurse = (indices: number[], region: Rect): void => {
    if (indices.length === 0) return;
    if (indices.length === 1) {
      result[indices[0]] = region;
      return;
    }
    const total = indices.reduce((acc, i) => acc + weights[i], 0);
    let split = 1;
    let acc = weights[indices[0]];
    for (let k = 1; k < indices.length; k++) {
      if (acc >= total / 2) break;
      acc += weights[indices[k]];
      split = k + 1;
    }
    if (split >= indices.length) split = indices.length - 1;
    const leftIdx = indices.slice(0, split);
    const rightIdx = indices.slice(split);
    const leftWeight = leftIdx.reduce((sum, i) => sum + weights[i], 0);
    const ratio = leftWeight / total;
    if (region.w >= region.h) {
      const availableW = Math.max(0, region.w - gap);
      const lw = availableW * ratio;
      recurse(leftIdx, { x: region.x, y: region.y, w: lw, h: region.h });
      recurse(rightIdx, { x: region.x + lw + gap, y: region.y, w: availableW - lw, h: region.h });
    } else {
      const availableH = Math.max(0, region.h - gap);
      const lh = availableH * ratio;
      recurse(leftIdx, { x: region.x, y: region.y, w: region.w, h: lh });
      recurse(rightIdx, { x: region.x, y: region.y + lh + gap, w: region.w, h: availableH - lh });
    }
  };
  recurse(weights.map((_, i) => i), rect);
  return result;
}

function fitZonesInGroup(count: number, group: Rect): { zones: Rect[]; cols: number } {
  if (count === 0) return { zones: [], cols: 0 };
  const innerW = Math.max(0, group.w - GROUP_INNER_PADDING * 2);
  const innerH = Math.max(0, group.h - GROUP_LABEL_HEIGHT - GROUP_INNER_PADDING);
  let bestCols = 1;
  let bestArea = -1;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const zoneW = (innerW - (cols - 1) * ZONE_GAP) / cols;
    const zoneH = (innerH - (rows - 1) * ZONE_GAP) / rows;
    if (zoneW <= 0 || zoneH <= 0) continue;
    const clampedW = Math.min(ZONE_MAX_WIDTH, zoneW);
    const clampedH = Math.min(ZONE_MAX_HEIGHT, zoneH);
    const area = clampedW * clampedH * count;
    const meetsMin = clampedW >= ZONE_MIN_WIDTH && clampedH >= ZONE_MIN_HEIGHT;
    const score = meetsMin ? area * 100 : area;
    if (score > bestArea) {
      bestArea = score;
      bestCols = cols;
    }
  }
  const cols = bestCols;
  const rows = Math.ceil(count / cols);
  const zoneW = Math.min(ZONE_MAX_WIDTH, Math.max(ZONE_MIN_WIDTH * 0.5, (innerW - (cols - 1) * ZONE_GAP) / cols));
  const zoneH = Math.min(ZONE_MAX_HEIGHT, Math.max(ZONE_MIN_HEIGHT * 0.5, (innerH - (rows - 1) * ZONE_GAP) / rows));
  const totalW = cols * zoneW + (cols - 1) * ZONE_GAP;
  const totalH = rows * zoneH + (rows - 1) * ZONE_GAP;
  const offsetX = GROUP_INNER_PADDING + Math.max(0, (innerW - totalW) / 2);
  const offsetY = GROUP_LABEL_HEIGHT + Math.max(0, (innerH - totalH) / 2);
  const zones: Rect[] = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    zones.push({
      x: offsetX + col * (zoneW + ZONE_GAP),
      y: offsetY + row * (zoneH + ZONE_GAP),
      w: zoneW,
      h: zoneH
    });
  }
  return { zones, cols };
}

function membershipKey(zones: { uuid: string }[]): string {
  return zones.map((zone) => zone.uuid).sort().join("|");
}

export function GroupEditor(props: GroupEditorProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  return (
    <section className="group-editor-panel maximized" aria-label="Group editor">
      <div className="section-heading">
        <div className="heading-leading">
          {props.onClose ? (
            <button
              className="icon-button compact"
              type="button"
              title="Done editing"
              aria-label="Done editing"
              onClick={props.onClose}
            >
              <ArrowLeft size={16} />
            </button>
          ) : null}
          <h2>Group Editor</h2>
        </div>
        <div className="heading-actions">
          <span>{props.busy ? "Saving" : `${props.groups.length} groups`}</span>
        </div>
      </div>
      <div className="group-editor-canvas" ref={canvasRef}>
        <ReactFlowProvider>
          <GroupFlow {...props} canvasRef={canvasRef} />
        </ReactFlowProvider>
      </div>
    </section>
  );
}

function GroupContainerNode({ data }: NodeProps<EditorNode>) {
  if (data.kind !== "group") return null;
  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        left: 14,
        color: data.color,
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        pointerEvents: "none"
      }}
    >
      {data.label}
    </div>
  );
}

interface MenuState {
  x: number;
  y: number;
  zoneId: string;
}

const PickedZoneContext = createContext<{
  pickedZoneId: string | null;
  openMenu: (state: MenuState) => void;
  suppressClickRef: { current: boolean };
} | null>(null);

function ZoneNode({ id, data }: NodeProps<EditorNode>) {
  const ctx = useContext(PickedZoneContext);
  const longPressTimerRef = useRef<number | null>(null);
  if (data.kind !== "zone") return null;
  const picked = ctx?.pickedZoneId === id;
  const borderColor = picked ? "#f2f0e8" : data.coordinator ? "#f2f0e8" : data.color;

  const cancelLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  return (
    <div
      className={picked ? "zone-node picked" : "zone-node"}
      onPointerDown={(event) => {
        const x = event.clientX;
        const y = event.clientY;
        cancelLongPress();
        longPressTimerRef.current = window.setTimeout(() => {
          if (ctx) {
            ctx.suppressClickRef.current = true;
            ctx.openMenu({ x, y, zoneId: id });
          }
        }, 500);
      }}
      onPointerMove={cancelLongPress}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onPointerLeave={cancelLongPress}
      style={{
        width: "100%",
        height: "100%",
        background: "#222827",
        color: "#f2f0e8",
        border: `2px ${picked ? "dashed" : "solid"} ${borderColor}`,
        borderRadius: 10,
        fontSize: 12,
        fontWeight: 600,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "4px 8px",
        cursor: "pointer",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none"
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>{data.label}</span>
    </div>
  );
}

const nodeTypes: NodeTypes = { groupContainer: GroupContainerNode, zoneNode: ZoneNode };

interface ZoneActionMenuProps {
  state: MenuState;
  groups: SonosGroup[];
  onClose: () => void;
  onPromote: (zoneId: string) => void;
  onMove: (zoneId: string, groupId: string) => void;
  onSplit: (zoneId: string) => void;
}

function ZoneActionMenu({ state, groups, onClose, onPromote, onMove, onSplit }: ZoneActionMenuProps) {
  let sourceGroup: SonosGroup | undefined;
  let zoneName = "";
  let isCoordinator = false;
  for (const group of groups) {
    const zone = group.zones.find((existing) => existing.id === state.zoneId);
    if (zone) {
      sourceGroup = group;
      zoneName = zone.name;
      isCoordinator = zone.uuid === group.coordinatorId;
      break;
    }
  }
  if (!sourceGroup) return null;
  const visibleSource = sourceGroup.zones.filter((zone) => zone.visible);
  const otherGroups = groups.filter((group) => group.id !== sourceGroup!.id && !isOptimisticGroupId(group.id));
  const canPromote = !isCoordinator && visibleSource.length > 1;
  const canSplit = visibleSource.length > 1;

  return (
    <>
      <div className="action-menu-backdrop" onClick={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }} />
      <div className="action-menu" style={{ left: state.x, top: state.y }} role="menu">
        <div className="action-menu-title">{zoneName}</div>
        {canPromote ? (
          <button type="button" className="action-menu-item" onClick={() => { onPromote(state.zoneId); onClose(); }}>
            Make lead of group
          </button>
        ) : null}
        {otherGroups.length > 0 ? <div className="action-menu-header">Move to</div> : null}
        {otherGroups.map((group) => {
          const visible = group.zones.filter((zone) => zone.visible);
          const { color, name } = paletteForMembers(visible.map((zone) => zone.uuid));
          const roomList = visible.map((zone) => zone.name).join(", ") || "empty";
          return (
            <button
              key={group.id}
              type="button"
              className="action-menu-item"
              onClick={() => { onMove(state.zoneId, group.id); onClose(); }}
            >
              <span className="action-menu-dot" style={{ background: color }} aria-hidden="true" />
              <span className="action-menu-item-label">
                <span>{name}</span>
                <small>{roomList}</small>
              </span>
            </button>
          );
        })}
        {canSplit ? (
          <button type="button" className="action-menu-item" onClick={() => { onSplit(state.zoneId); onClose(); }}>
            <span className="action-menu-dot action-menu-dot-new" aria-hidden="true">+</span>
            <span className="action-menu-item-label"><span>New group</span></span>
          </button>
        ) : null}
        <button type="button" className="action-menu-item action-menu-cancel" onClick={onClose}>Cancel</button>
      </div>
    </>
  );
}

interface GroupFlowProps extends GroupEditorProps {
  canvasRef: RefObject<HTMLDivElement | null>;
}

function GroupFlow({ groups, selectedGroupId, onSelectGroup, onJoinZoneGroup, onUngroupZone, onPromoteZone, canvasRef }: GroupFlowProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<EditorNode>([]);
  const [edges, , onEdgesChange] = useEdgesState([]);
  const reactFlow = useReactFlow();

  const callbacksRef = useRef({ onSelectGroup, onJoinZoneGroup, onUngroupZone, onPromoteZone });
  callbacksRef.current = { onSelectGroup, onJoinZoneGroup, onUngroupZone, onPromoteZone };

  const [pickedZone, setPickedZone] = useState<{ zoneId: string; groupId: string; label: string } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const suppressClickRef = useRef(false);
  const openMenu = useCallback((state: MenuState) => setMenu(state), []);
  const pickedContext = useMemo(
    () => ({ pickedZoneId: pickedZone?.zoneId ?? null, openMenu, suppressClickRef }),
    [pickedZone, openMenu]
  );

  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number }>({ w: FALLBACK_CANVAS_WIDTH, h: FALLBACK_CANVAS_HEIGHT });

  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w > 0 && h > 0) setCanvasSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
  }, [canvasRef]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let pending = 0;
    const update = () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        const w = Math.round(rect.width);
        const h = Math.round(rect.height);
        if (w <= 0 || h <= 0) return;
        setCanvasSize((prev) => {
          if (Math.abs(prev.w - w) < 4 && Math.abs(prev.h - h) < 4) return prev;
          return { w, h };
        });
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      cancelAnimationFrame(pending);
      observer.disconnect();
    };
  }, [canvasRef]);

  useEffect(() => {
    const id = requestAnimationFrame(() => reactFlow.fitView({ padding: 0.02, duration: 0 }));
    return () => cancelAnimationFrame(id);
  }, [canvasSize, reactFlow]);
  const slotsRef = useRef<Map<string, number>>(new Map());
  const layout = useMemo(
    () => buildLayout(groups, selectedGroupId, slotsRef.current, canvasSize),
    [groups, selectedGroupId, canvasSize]
  );
  const layoutKey = useMemo(() => JSON.stringify(layout), [layout]);
  const lastKeyRef = useRef("");

  useEffect(() => {
    if (lastKeyRef.current === layoutKey) return;
    lastKeyRef.current = layoutKey;
    setNodes(layout);
  }, [layoutKey, layout, setNodes]);

  const nodesInitialized = useNodesInitialized();

  useEffect(() => {
    if (!nodesInitialized) return;
    const id = requestAnimationFrame(() => {
      const groupBounds = layout
        .filter((node) => node.data.kind === "group")
        .map((node) => {
          const w = typeof node.style?.width === "number" ? node.style.width : 0;
          const h = typeof node.style?.height === "number" ? node.style.height : 0;
          return { x: node.position.x, y: node.position.y, w, h };
        })
        .filter((box) => box.w > 0 && box.h > 0);
      if (groupBounds.length === 0) {
        reactFlow.fitView({ padding: 0.05, duration: 0 });
        return;
      }
      const minX = Math.min(...groupBounds.map((b) => b.x));
      const minY = Math.min(...groupBounds.map((b) => b.y));
      const maxX = Math.max(...groupBounds.map((b) => b.x + b.w));
      const maxY = Math.max(...groupBounds.map((b) => b.y + b.h));
      reactFlow.fitBounds(
        { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
        { padding: 0.05, duration: 0 }
      );
    });
    return () => cancelAnimationFrame(id);
  }, [nodesInitialized, layoutKey, layout, reactFlow]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<EditorNode>[]) => {
      onNodesChange(changes.filter((change) => change.type !== "remove"));
    },
    [onNodesChange]
  );

  const handleNodeClick = useCallback<NodeMouseHandler<EditorNode>>((_event, node) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const data = node.data;
    if (pickedZone) {
      const targetGroupId = data.groupId;
      if (!targetGroupId || isOptimisticGroupId(targetGroupId)) {
        setPickedZone(null);
        return;
      }
      if (pickedZone.groupId !== targetGroupId) {
        callbacksRef.current.onJoinZoneGroup(pickedZone.zoneId, targetGroupId);
      }
      setPickedZone(null);
      return;
    }
    if (data.kind === "group") {
      callbacksRef.current.onSelectGroup(data.groupId);
      return;
    }
    if (data.kind === "zone" && data.groupId) {
      setPickedZone({ zoneId: data.zoneId, groupId: data.groupId, label: data.label });
      callbacksRef.current.onSelectGroup(data.groupId);
    }
  }, [pickedZone]);

  const handlePaneClick = useCallback(() => {
    if (!pickedZone) return;
    const group = groups.find((existing) => existing.id === pickedZone.groupId);
    const peerCount = group ? group.zones.filter((zone) => zone.visible).length : 0;
    if (peerCount > 1) {
      callbacksRef.current.onUngroupZone(pickedZone.zoneId);
    }
    setPickedZone(null);
  }, [pickedZone, groups]);

  const handleNodeContextMenu = useCallback<NodeMouseHandler<EditorNode>>((event, node) => {
    if (node.data.kind !== "zone") return;
    if (!node.data.groupId) return;
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, zoneId: node.data.zoneId });
  }, []);

  const pickedLabel = pickedZone?.label ?? null;

  return (
    <PickedZoneContext.Provider value={pickedContext}>
    <div className={pickedZone ? "group-editor-overlay-hint pick-mode" : "group-editor-overlay-hint"}>
      {pickedLabel
        ? `Moving ${pickedLabel} — tap a color to join, tap empty space to start a new group, or tap ${pickedLabel} again to cancel.`
        : "Tap a room to pick it up."}
    </div>
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={handleNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={handleNodeClick}
      onPaneClick={handlePaneClick}
      onNodeContextMenu={handleNodeContextMenu}
      nodesConnectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      panOnDrag={false}
      panOnScroll={false}
      zoomOnScroll={false}
      zoomOnPinch={false}
      zoomOnDoubleClick={false}
      selectionOnDrag={false}
      selectNodesOnDrag={false}
      nodeDragThreshold={3}
      fitView
      fitViewOptions={{ padding: 0.15 }}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={28} color="rgba(242, 240, 232, 0.08)" />
    </ReactFlow>
    {menu ? (
      <ZoneActionMenu
        state={menu}
        groups={groups}
        onClose={() => { suppressClickRef.current = false; setMenu(null); }}
        onPromote={(zoneId) => callbacksRef.current.onPromoteZone(zoneId)}
        onMove={(zoneId, groupId) => callbacksRef.current.onJoinZoneGroup(zoneId, groupId)}
        onSplit={(zoneId) => callbacksRef.current.onUngroupZone(zoneId)}
      />
    ) : null}
    </PickedZoneContext.Provider>
  );
}

function buildLayout(
  groups: SonosGroup[],
  selectedGroupId: string | undefined,
  slots: Map<string, number>,
  canvas: { w: number; h: number }
): EditorNode[] {
  const visibleZonesByGroup = groups.map((group) =>
    group.zones.filter((zone) => zone.visible).slice().sort((a, b) => a.uuid.localeCompare(b.uuid))
  );
  const memberKeys = visibleZonesByGroup.map(membershipKey);

  const liveKeys = new Set(memberKeys);
  for (const key of Array.from(slots.keys())) {
    if (!liveKeys.has(key)) slots.delete(key);
  }
  for (const key of memberKeys) {
    if (slots.has(key)) continue;
    const used = new Set(slots.values());
    let next = 0;
    while (used.has(next)) next++;
    slots.set(key, next);
  }
  const groupSlots = memberKeys.map((key) => slots.get(key) as number);

  const order = groups.map((_, index) => index).sort((a, b) => groupSlots[a] - groupSlots[b]);
  const weights = order.map((index) => Math.max(1, visibleZonesByGroup[index].length));
  const innerWidth = Math.max(160, canvas.w - CANVAS_PADDING_X * 2);
  const innerHeight = Math.max(120, canvas.h - CANVAS_TOP_RESERVED - CANVAS_BOTTOM_RESERVED);
  const rects = sliceAndDice(weights, { x: CANVAS_PADDING_X, y: CANVAS_TOP_RESERVED, w: innerWidth, h: innerHeight }, GROUP_GAP);

  const result: EditorNode[] = [];
  order.forEach((index, orderIndex) => {
    const group = groups[index];
    const visibleZones = visibleZonesByGroup[index];
    const { color, name } = paletteForMembers(visibleZones.map((zone) => zone.uuid));
    const isSelected = group.id === selectedGroupId;
    const rect = rects[orderIndex];
    const { zones } = fitZonesInGroup(visibleZones.length, rect);

    result.push({
      id: groupNodeId(group.id),
      type: "groupContainer",
      position: { x: rect.x, y: rect.y },
      data: { kind: "group", groupId: group.id, label: name, color, selected: isSelected },
      draggable: false,
      selectable: true,
      style: {
        width: rect.w,
        height: rect.h,
        background: hexToRgba(color, 0.18),
        border: `2px solid ${isSelected ? "#f2f0e8" : color}`,
        borderRadius: 14,
        padding: 0
      }
    });

    visibleZones.forEach((zone, zoneIndex) => {
      const zoneRect = zones[zoneIndex];
      result.push({
        id: zone.id,
        type: "zoneNode",
        parentId: groupNodeId(group.id),
        extent: undefined,
        position: { x: zoneRect.x, y: zoneRect.y },
        data: {
          kind: "zone",
          zoneId: zone.id,
          groupId: group.id,
          label: zone.name,
          color,
          coordinator: zone.uuid === group.coordinatorId
        },
        draggable: false,
        selectable: true,
        style: { width: zoneRect.w, height: zoneRect.h, background: "transparent", border: "none", padding: 0 }
      });
    });
  });
  return result;
}

function groupNodeId(groupId: string): string {
  return `group:${groupId}`;
}

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const bigint = parseInt(value, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function isOptimisticGroupId(groupId: string): boolean {
  return groupId.startsWith("pending:");
}
