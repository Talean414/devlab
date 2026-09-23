// Phase 9O — draws the architecture layout as inline SVG. Presentation only: the component receives
// a finished layout and reports clicks; it never fetches, caches or writes anything.

import type { DiagramLayout } from "../lib/diagramLayout";

interface ArchitectureDiagramProps {
  layout: DiagramLayout;
  selected: string | null;
  scale: number;
  onSelect: (module: string | null) => void;
}

const ARROW_MARKER_ID = "devlab-architecture-arrow";

export function ArchitectureDiagram({ layout, selected, scale, onSelect }: ArchitectureDiagramProps) {
  const adjacent = new Set<string>();
  if (selected) {
    adjacent.add(selected);
    for (const edge of layout.edges) {
      if (edge.from === selected) adjacent.add(edge.to);
      if (edge.to === selected) adjacent.add(edge.from);
    }
  }
  const width = Math.max(1, layout.width);
  const height = Math.max(1, layout.height);
  return (
    <svg
      role="img"
      aria-label={`Architecture diagram: ${layout.nodes.length} modules and ${layout.edges.length} import edges, arrows point from the importing module to the imported module`}
      viewBox={`0 0 ${width} ${height}`}
      width={Math.round(width * scale)}
      height={Math.round(height * scale)}
      className="block select-none"
      onClick={() => onSelect(null)}
    >
      <defs>
        <marker id={ARROW_MARKER_ID} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#67e8f9" />
        </marker>
      </defs>
      {layout.edges.map((edge) => {
        const dimmed = selected !== null && edge.from !== selected && edge.to !== selected;
        const strokeWidth = 1 + Math.min(3, Math.log2(Math.max(1, edge.weight)));
        return (
          <g key={`${edge.from}->${edge.to}`} opacity={dimmed ? 0.12 : 0.85}>
            <path
              d={edge.path}
              fill="none"
              stroke={edge.backward ? "#fbbf24" : "#67e8f9"}
              strokeWidth={strokeWidth}
              strokeDasharray={edge.backward ? "6 4" : undefined}
              markerEnd={`url(#${ARROW_MARKER_ID})`}
            >
              <title>{`${edge.from} imports ${edge.to} (${edge.weight} file-level import${edge.weight === 1 ? "" : "s"})${edge.backward ? " — closes a cycle" : ""}`}</title>
            </path>
            {edge.weight > 1 && (
              <text x={edge.labelX} y={edge.labelY} fontSize={10} textAnchor="middle" fill={edge.backward ? "#fde68a" : "#a5f3fc"}>
                {edge.weight}
              </text>
            )}
          </g>
        );
      })}
      {layout.nodes.map((node) => {
        const isSelected = node.module === selected;
        const dimmed = selected !== null && !adjacent.has(node.module);
        return (
          <g
            key={node.module}
            className="cursor-pointer"
            opacity={dimmed ? 0.35 : 1}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(isSelected ? null : node.module);
            }}
          >
            <rect
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              rx={8}
              fill={isSelected ? "rgba(8, 51, 68, 0.96)" : "rgba(15, 23, 42, 0.92)"}
              stroke={isSelected ? "#67e8f9" : "rgba(103, 232, 249, 0.45)"}
              strokeWidth={isSelected ? 1.6 : 1}
            />
            <text x={node.x + node.width / 2} y={node.y + 17} fontSize={11} fontWeight={600} textAnchor="middle" fill="#e0fbff">
              {node.label}
            </text>
            <text x={node.x + node.width / 2} y={node.y + 31} fontSize={9} textAnchor="middle" fill="#8fc7d8">
              {`${node.files} file${node.files === 1 ? "" : "s"} \u00b7 ${node.importance.toFixed(2)}\u00d7`}
            </text>
            <title>{`${node.module} — ${node.files} file${node.files === 1 ? "" : "s"}, importance ${node.importance.toFixed(2)}×, layer ${node.layer + 1}`}</title>
          </g>
        );
      })}
    </svg>
  );
}
