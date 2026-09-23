// Phase 9O — in-UI architecture diagram layout. Turns the modules and edges selected for the
// Mermaid diagram (Phase 9M) into positioned boxes and curved arrows so DevLab can draw the picture
// itself, without a charting dependency. Pure and deterministic: the same graph always yields the
// same layout. Nothing here touches the workspace, the network or persisted state.
//
// The layout is a small layered ("Sugiyama-lite") drawing, left to right:
//   1. break cycles by reversing the back edges found by a depth-first search in importance order;
//   2. assign layers by longest path from the modules nothing else imports (entry points on the
//      left, shared libraries on the right);
//   3. reduce crossings with a few barycenter sweeps;
//   4. place boxes on a grid and route each edge as a cubic Bézier from importer to imported module.

import type { CodeGraph } from "./codeGraph";
import { selectDiagram } from "./architecture";

export interface DiagramNode {
  module: string;
  label: string;
  files: number;
  importance: number;
  layer: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiagramEdge {
  /** Importing module. */
  from: string;
  /** Imported module. */
  to: string;
  weight: number;
  /** True when the edge closes a cycle and points back toward an earlier layer (drawn dashed). */
  backward: boolean;
  /** SVG path data from the importing module's box to the imported module's box. */
  path: string;
  labelX: number;
  labelY: number;
}

export interface DiagramLayout {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  width: number;
  height: number;
  layers: number;
  backwardEdges: number;
  /** Modules in the graph that the diagram does not show (least important or unconnected). */
  hiddenModules: number;
}

export const NODE_HEIGHT = 40;
const MIN_NODE_WIDTH = 120;
const MAX_NODE_WIDTH = 240;
const CHAR_WIDTH = 7.2;
const LAYER_GAP = 96;
const ROW_GAP = 18;
const PADDING = 24;
const MAX_LABEL_CHARS = 32;
const ORDERING_SWEEPS = 4;

const EMPTY_LAYOUT: DiagramLayout = { nodes: [], edges: [], width: 0, height: 0, layers: 0, backwardEdges: 0, hiddenModules: 0 };

export function layoutArchitecture(graph: CodeGraph): DiagramLayout {
  const selection = selectDiagram(graph);
  if (selection.modules.length === 0 || selection.edges.length === 0) {
    return { ...EMPTY_LAYOUT, hiddenModules: graph.moduleCount };
  }
  const order = selection.modules.map((module) => module.module);
  const index = new Map<string, number>();
  order.forEach((name, position) => index.set(name, position));
  const outgoing = new Map<string, string[]>();
  for (const name of order) outgoing.set(name, []);
  for (const edge of selection.edges) {
    outgoing.get(edge.from)?.push(edge.to);
  }

  // 1. Cycle breaking: depth-first search from the most important module; an edge to a module that
  //    is still on the stack closes a cycle and is treated as reversed for layering only.
  const state = new Map<string, 0 | 1 | 2>();
  const backward = new Set<string>();
  const visit = (name: string) => {
    state.set(name, 1);
    for (const next of outgoing.get(name) ?? []) {
      const nextState = state.get(next) ?? 0;
      if (nextState === 1) {
        backward.add(edgeKey(name, next));
      } else if (nextState === 0) {
        visit(next);
      }
    }
    state.set(name, 2);
  };
  for (const name of order) {
    if ((state.get(name) ?? 0) === 0) visit(name);
  }

  // 2. Longest-path layering over the now-acyclic graph (Kahn's algorithm keeps it deterministic).
  const successors = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const name of order) {
    successors.set(name, []);
    indegree.set(name, 0);
  }
  for (const edge of selection.edges) {
    const reversed = backward.has(edgeKey(edge.from, edge.to));
    const from = reversed ? edge.to : edge.from;
    const to = reversed ? edge.from : edge.to;
    successors.get(from)?.push(to);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }
  const layer = new Map<string, number>();
  const queue = order.filter((name) => (indegree.get(name) ?? 0) === 0);
  for (const name of order) layer.set(name, 0);
  let cursor = 0;
  while (cursor < queue.length) {
    const current = queue[cursor];
    cursor += 1;
    const currentLayer = layer.get(current) ?? 0;
    for (const next of successors.get(current) ?? []) {
      layer.set(next, Math.max(layer.get(next) ?? 0, currentLayer + 1));
      const remaining = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  const layerCount = Math.max(...order.map((name) => layer.get(name) ?? 0)) + 1;

  // 3. Crossing reduction: order each layer by the average position of its neighbours in the
  //    adjacent layer, sweeping left-to-right then right-to-left a few times.
  const neighbours = new Map<string, string[]>();
  for (const name of order) neighbours.set(name, []);
  for (const edge of selection.edges) {
    neighbours.get(edge.from)?.push(edge.to);
    neighbours.get(edge.to)?.push(edge.from);
  }
  const layers: string[][] = Array.from({ length: layerCount }, () => []);
  for (const name of order) layers[layer.get(name) ?? 0].push(name);
  const position = new Map<string, number>();
  const refreshPositions = () => {
    for (const members of layers) members.forEach((name, row) => position.set(name, row));
  };
  refreshPositions();
  const reorder = (members: string[], reference: number) => {
    const barycenter = new Map<string, number>();
    for (const name of members) {
      const adjacent = (neighbours.get(name) ?? []).filter((other) => (layer.get(other) ?? 0) === reference);
      barycenter.set(
        name,
        adjacent.length === 0
          ? position.get(name) ?? 0
          : adjacent.reduce((sum, other) => sum + (position.get(other) ?? 0), 0) / adjacent.length,
      );
    }
    members.sort((left, right) =>
      (barycenter.get(left) ?? 0) - (barycenter.get(right) ?? 0)
      || (index.get(left) ?? 0) - (index.get(right) ?? 0));
  };
  for (let sweep = 0; sweep < ORDERING_SWEEPS; sweep += 1) {
    for (let current = 1; current < layerCount; current += 1) {
      reorder(layers[current], current - 1);
      refreshPositions();
    }
    for (let current = layerCount - 2; current >= 0; current -= 1) {
      reorder(layers[current], current + 1);
      refreshPositions();
    }
  }

  // 4. Coordinates: one column per layer, boxes centred within the column, columns centred vertically.
  const nodeWidth = new Map<string, number>();
  for (const module of selection.modules) {
    nodeWidth.set(module.module, clamp(Math.round(labelFor(module.module).length * CHAR_WIDTH + 28), MIN_NODE_WIDTH, MAX_NODE_WIDTH));
  }
  const columnWidths = layers.map((members) => Math.max(...members.map((name) => nodeWidth.get(name) ?? MIN_NODE_WIDTH)));
  const columnHeights = layers.map((members) => members.length * NODE_HEIGHT + Math.max(0, members.length - 1) * ROW_GAP);
  const tallest = Math.max(...columnHeights);
  const columnX: number[] = [];
  let x = PADDING;
  for (const width of columnWidths) {
    columnX.push(x);
    x += width + LAYER_GAP;
  }
  const width = x - LAYER_GAP + PADDING;
  const height = tallest + PADDING * 2;
  const nodes: DiagramNode[] = [];
  const byName = new Map<string, DiagramNode>();
  const moduleInfo = new Map(selection.modules.map((module) => [module.module, module]));
  layers.forEach((members, layerIndex) => {
    const top = PADDING + (tallest - columnHeights[layerIndex]) / 2;
    members.forEach((name, row) => {
      const module = moduleInfo.get(name);
      const boxWidth = nodeWidth.get(name) ?? MIN_NODE_WIDTH;
      const node: DiagramNode = {
        module: name,
        label: labelFor(name),
        files: module?.files ?? 0,
        importance: module?.importance ?? 0,
        layer: layerIndex,
        row,
        x: round(columnX[layerIndex] + (columnWidths[layerIndex] - boxWidth) / 2),
        y: round(top + row * (NODE_HEIGHT + ROW_GAP)),
        width: boxWidth,
        height: NODE_HEIGHT,
      };
      nodes.push(node);
      byName.set(name, node);
    });
  });

  const edges: DiagramEdge[] = [];
  for (const edge of selection.edges) {
    const from = byName.get(edge.from);
    const to = byName.get(edge.to);
    if (!from || !to) continue;
    const isBackward = backward.has(edgeKey(edge.from, edge.to));
    const start = isBackward
      ? { x: from.x, y: from.y + from.height / 2 }
      : { x: from.x + from.width, y: from.y + from.height / 2 };
    const end = isBackward
      ? { x: to.x + to.width, y: to.y + to.height / 2 }
      : { x: to.x, y: to.y + to.height / 2 };
    const reach = Math.max(LAYER_GAP / 2, Math.abs(end.x - start.x) / 2);
    const control1 = { x: isBackward ? start.x - reach : start.x + reach, y: start.y };
    const control2 = { x: isBackward ? end.x + reach : end.x - reach, y: end.y };
    const path = `M ${round(start.x)} ${round(start.y)} C ${round(control1.x)} ${round(control1.y)}, ${round(control2.x)} ${round(control2.y)}, ${round(end.x)} ${round(end.y)}`;
    edges.push({
      from: edge.from,
      to: edge.to,
      weight: edge.weight,
      backward: isBackward,
      path,
      labelX: round((start.x + 3 * control1.x + 3 * control2.x + end.x) / 8),
      labelY: round((start.y + 3 * control1.y + 3 * control2.y + end.y) / 8 - 4),
    });
  }

  return {
    nodes,
    edges,
    width: round(width),
    height: round(height),
    layers: layerCount,
    backwardEdges: edges.filter((edge) => edge.backward).length,
    hiddenModules: Math.max(0, graph.moduleCount - nodes.length),
  };
}

export function describeLayout(layout: DiagramLayout, graph: CodeGraph): string {
  const parts = [
    `${layout.nodes.length} of ${graph.moduleCount} module${graph.moduleCount === 1 ? "" : "s"}`,
    `${layout.edges.length} edge${layout.edges.length === 1 ? "" : "s"}`,
    `${layout.layers} layer${layout.layers === 1 ? "" : "s"}`,
  ];
  if (layout.backwardEdges > 0) parts.push(`${layout.backwardEdges} cycle edge${layout.backwardEdges === 1 ? "" : "s"} dashed`);
  return parts.join(" · ");
}

function labelFor(module: string): string {
  if (module.length <= MAX_LABEL_CHARS) return module;
  return `\u2026${module.slice(module.length - (MAX_LABEL_CHARS - 1))}`;
}

function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
