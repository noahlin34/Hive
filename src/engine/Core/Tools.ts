export const Tool = {
  FLOOR: 'floor',
  ELEVATOR: 'elevator',
  DELETE: 'delete',
} as const;

export type Tool = (typeof Tool)[keyof typeof Tool];

export const TOOL_COSTS: Record<Tool, number> = {
  [Tool.FLOOR]: 500,
  [Tool.ELEVATOR]: 2000,
  [Tool.DELETE]: 0,
};

export const TOOL_LABELS: Record<Tool, string> = {
  [Tool.FLOOR]: 'Floor',
  [Tool.ELEVATOR]: 'Elevator',
  [Tool.DELETE]: 'Delete',
};
