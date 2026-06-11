import * as go from "gojs";
import { Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SonosGroup } from "@misonos/sonos-protocol";

interface GroupEditorProps {
  groups: SonosGroup[];
  selectedGroupId?: string;
  busy?: boolean;
  onSelectGroup: (groupId: string) => void;
  onJoinZoneGroup: (zoneId: string, groupId: string) => void;
  onUngroupZone: (zoneId: string) => void;
}

interface GroupNodeData {
  key: string;
  isGroup: true;
  groupId: string;
  label: string;
  color: string;
  stroke: string;
  loc: string;
}

interface ZoneNodeData {
  key: string;
  zoneId: string;
  group: string;
  groupId?: string;
  label: string;
  shortLabel: string;
  color: string;
  stroke: string;
  coordinator: boolean;
}

const palette = [
  "#91d3c4",
  "#f1b555",
  "#8fb8ff",
  "#ff8a80",
  "#c2a5ff",
  "#84d982",
  "#f08ec4",
  "#a8c66c"
];

export function GroupEditor({ groups, selectedGroupId, busy = false, onSelectGroup, onJoinZoneGroup, onUngroupZone }: GroupEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const diagramRef = useRef<go.Diagram | null>(null);
  const modelKeyRef = useRef("");
  const callbacksRef = useRef({ onSelectGroup, onJoinZoneGroup, onUngroupZone });
  const [maximized, setMaximized] = useState(false);

  callbacksRef.current = { onSelectGroup, onJoinZoneGroup, onUngroupZone };

  const modelData = useMemo(() => buildModelData(groups, selectedGroupId), [groups, selectedGroupId]);

  useEffect(() => {
    if (!hostRef.current || diagramRef.current) return;
    if (isJsdom()) return;
    const $ = go.GraphObject.make;
    const diagram = $(go.Diagram, hostRef.current, {
      "undoManager.isEnabled": false,
      "animationManager.isEnabled": true,
      allowCopy: false,
      allowDelete: false,
      allowLink: false,
      "toolManager.dragSelectingTool.isEnabled": true,
      "toolManager.dragSelectingTool.isPartialInclusion": true,
      padding: 24,
      layout: $(go.GridLayout, {
        wrappingColumn: 3,
        spacing: new go.Size(34, 30),
        comparer: (left, right) => String(left.data.label).localeCompare(String(right.data.label))
      }),
      "SelectionMoved": (event) => {
        const diagram = event.diagram;
        const movedZones = selectedZoneNodes(diagram);
        if (movedZones.length === 0) return;
        const sourceGroupSizes = groupSizesById(diagram);
        const nearest = nearestGroupForNodes(diagram, movedZones);
        if (nearest?.groupId && !isOptimisticGroupId(nearest.groupId)) {
          for (const node of movedZones) {
            const zone = node.data as ZoneNodeData;
            if (nearest.groupId === zone.groupId) continue;
            diagram.model.setDataProperty(zone, "group", groupKey(nearest.groupId));
            diagram.model.setDataProperty(zone, "groupId", nearest.groupId);
            callbacksRef.current.onJoinZoneGroup(zone.zoneId, nearest.groupId);
          }
          return;
        }
        for (const node of movedZones) {
          const zone = node.data as ZoneNodeData;
          if (!zone.groupId || isOptimisticGroupId(zone.groupId)) continue;
          if ((sourceGroupSizes.get(zone.groupId) ?? 0) <= 1) continue;
          diagram.model.setDataProperty(zone, "group", undefined);
          diagram.model.setDataProperty(zone, "groupId", undefined);
          callbacksRef.current.onUngroupZone(zone.zoneId);
        }
      }
    });

    diagram.groupTemplate = $(
      go.Group,
      "Auto",
      {
        movable: false,
        selectable: true,
        selectionAdorned: false,
        computesBoundsAfterDrag: true,
        click: (_event, group) => {
          const groupId = (group.part?.data as GroupNodeData | undefined)?.groupId;
          if (groupId) callbacksRef.current.onSelectGroup(groupId);
        }
      },
      $(
        go.Shape,
        "Circle",
        {
          minSize: new go.Size(174, 174),
          strokeWidth: 4,
          opacity: 0.2
        },
        new go.Binding("fill", "color"),
        new go.Binding("stroke", "stroke")
      ),
      $(
        go.Panel,
        "Vertical",
        { margin: 18 },
        $(
          go.TextBlock,
          {
            margin: new go.Margin(0, 0, 10, 0),
            stroke: "#f2f0e8",
            font: "700 14px Inter, sans-serif"
          },
          new go.Binding("text", "label")
        ),
        $(go.Placeholder, { padding: 20 })
      )
    );

    diagram.nodeTemplate = $(
      go.Node,
      "Spot",
      {
        movable: true,
        cursor: "grab",
        selectionAdorned: false,
        mouseDragEnter: (_event, node) => {
          node.cursor = "grabbing";
        },
        mouseDragLeave: (_event, node) => {
          node.cursor = "grab";
        },
        click: (_event, node) => {
          const groupId = (node.part?.data as ZoneNodeData | undefined)?.groupId;
          if (groupId) callbacksRef.current.onSelectGroup(groupId);
        }
      },
      $(
        go.Panel,
        "Auto",
        $(
          go.Shape,
          "Circle",
          {
            width: 72,
            height: 72,
            strokeWidth: 3,
            fill: "#222827"
          },
          new go.Binding("stroke", "stroke")
        ),
        $(
          go.TextBlock,
          {
            stroke: "#f2f0e8",
            font: "800 20px Inter, sans-serif",
            textAlign: "center"
          },
          new go.Binding("text", "shortLabel")
        )
      ),
      $(
        go.Shape,
        "Circle",
        {
          alignment: go.Spot.TopRight,
          width: 15,
          height: 15,
          strokeWidth: 0,
          fill: "#91d3c4"
        },
        new go.Binding("visible", "coordinator")
      ),
      $(
        go.TextBlock,
        {
          alignment: go.Spot.Bottom,
          alignmentFocus: go.Spot.Top,
          margin: new go.Margin(8, 0, 0, 0),
          stroke: "#d7d2c4",
          font: "600 12px Inter, sans-serif",
          maxSize: new go.Size(112, NaN),
          textAlign: "center",
          overflow: go.TextOverflow.Ellipsis
        },
        new go.Binding("text", "label")
      )
    );

    diagramRef.current = diagram;
    return () => {
      diagram.div = null;
      diagramRef.current = null;
    };
  }, []);

  useEffect(() => {
    const diagram = diagramRef.current;
    if (!diagram) return;
    const nextKey = JSON.stringify(modelData);
    if (modelKeyRef.current === nextKey) return;
    modelKeyRef.current = nextKey;
    diagram.model = new go.GraphLinksModel({
      nodeDataArray: [...modelData.groups, ...modelData.zones],
      linkDataArray: []
    });
  }, [modelData]);

  return (
    <section className={maximized ? "group-editor-panel maximized" : "group-editor-panel"} aria-label="Group editor">
      <div className="section-heading">
        <h2>Group Editor</h2>
        <div className="heading-actions">
          <span>{busy ? "Saving" : `${groups.length} groups`}</span>
          <button
            className="icon-button compact"
            type="button"
            title={maximized ? "Minimize group editor" : "Maximize group editor"}
            aria-label={maximized ? "Minimize group editor" : "Maximize group editor"}
            onClick={() => setMaximized((current) => !current)}
          >
            {maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        </div>
      </div>
      <div className="group-editor-hint">Drag a room into a color to join it. Drag it outside to split it out.</div>
      <div className="group-editor-canvas" ref={hostRef} />
    </section>
  );
}

function isJsdom(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("jsdom");
}

function buildModelData(groups: SonosGroup[], selectedGroupId?: string) {
  const groupNodes: GroupNodeData[] = groups.map((group, index) => {
    const color = palette[index % palette.length];
    return {
      key: groupKey(group.id),
      isGroup: true,
      groupId: group.id,
      label: group.coordinatorName,
      color,
      stroke: group.id === selectedGroupId ? "#f2f0e8" : color,
      loc: `${index * 210} 0`
    };
  });
  const zoneNodes: ZoneNodeData[] = groups.flatMap((group, index) => {
    const color = palette[index % palette.length];
    return group.zones.map((zone) => ({
      key: zone.id,
      zoneId: zone.id,
      group: groupKey(group.id),
      groupId: group.id,
      label: zone.name,
      shortLabel: initials(zone.name),
      color,
      stroke: zone.uuid === group.coordinatorId ? "#f2f0e8" : color,
      coordinator: zone.uuid === group.coordinatorId
    }));
  });
  return { groups: groupNodes, zones: zoneNodes };
}

function groupKey(groupId: string): string {
  return `group:${groupId}`;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words.slice(0, 2).map((word) => word[0].toUpperCase()).join("");
}

function selectedZoneNodes(diagram: go.Diagram): go.Node[] {
  const nodes: go.Node[] = [];
  diagram.selection.each((part) => {
    if (part instanceof go.Node && part.data && !part.data.isGroup) nodes.push(part);
  });
  return nodes;
}

function nearestGroupForNodes(diagram: go.Diagram, nodes: go.Node[]): GroupNodeData | undefined {
  const bounds = nodes.reduce(
    (accumulator, node) => accumulator.unionRect(node.actualBounds),
    nodes[0].actualBounds.copy()
  );
  const center = bounds.center;
  let nearest: { distance: number; data: GroupNodeData } | undefined;
  diagram.nodes.each((candidate) => {
    if (!candidate.data?.isGroup) return;
    const bounds = candidate.actualBounds;
    const candidateCenter = bounds.center;
    const distance = Math.hypot(center.x - candidateCenter.x, center.y - candidateCenter.y);
    const threshold = Math.max(bounds.width, bounds.height) * 0.58;
    if (distance <= threshold && (!nearest || distance < nearest.distance)) {
      nearest = { distance, data: candidate.data as GroupNodeData };
    }
  });
  return nearest?.data;
}

function groupSizesById(diagram: go.Diagram): Map<string, number> {
  const sizes = new Map<string, number>();
  diagram.nodes.each((candidate) => {
    const groupId = candidate.data?.groupId;
    if (!candidate.data?.isGroup && typeof groupId === "string") {
      sizes.set(groupId, (sizes.get(groupId) ?? 0) + 1);
    }
  });
  return sizes;
}

function isOptimisticGroupId(groupId: string): boolean {
  return groupId.startsWith("pending:");
}
