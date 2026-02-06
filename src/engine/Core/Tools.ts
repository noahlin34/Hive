export const Tool = {
  FLOOR: 'floor',
  OFFICE: 'office',
  CONDO: 'condo',
  FOOD_COURT: 'food_court',
  ELEVATOR: 'elevator',
  DELETE: 'delete',
} as const;

export type Tool = (typeof Tool)[keyof typeof Tool];

export const TOOL_COSTS: Record<Tool, number> = {
  [Tool.FLOOR]: 10,
  [Tool.OFFICE]: 700,
  [Tool.CONDO]: 900,
  [Tool.FOOD_COURT]: 1200,
  [Tool.ELEVATOR]: 2000,
  [Tool.DELETE]: 0,
};

export const TOOL_LABELS: Record<Tool, string> = {
  [Tool.FLOOR]: 'Floor',
  [Tool.OFFICE]: 'Office',
  [Tool.CONDO]: 'Condo',
  [Tool.FOOD_COURT]: 'Food Court',
  [Tool.ELEVATOR]: 'Elevator',
  [Tool.DELETE]: 'Delete',
};
