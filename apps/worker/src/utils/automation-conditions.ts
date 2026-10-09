export interface AutomationConditions {
  tag_id?: string;
  keyword?: string;
  score_threshold?: number;
}

/** Unknown fields must never silently turn a condition into an unconditional rule. */
export function validConditions(value: unknown, eventType?:string): value is AutomationConditions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (eventType === 'follow') return Object.entries(value).every(([key,v]) => key==='ref' && typeof v==='string' && v.trim().length>0);
  return Object.entries(value).every(([key, v]) => {
    if (key === 'tag_id' || key === 'keyword') return typeof v === 'string' && v.trim().length > 0;
    if (key === 'score_threshold') return typeof v === 'number' && Number.isFinite(v);
    return false;
  });
}

export function matchConditions(conditions: unknown, payload: { eventData?: Record<string, unknown> }): boolean {
  if (!validConditions(conditions)) return false;
  const data = payload.eventData ?? {};
  if (conditions.tag_id !== undefined && data.tagId !== conditions.tag_id) return false;
  if (conditions.keyword !== undefined && (typeof data.text !== 'string' || !data.text.includes(conditions.keyword))) return false;
  if (conditions.score_threshold !== undefined &&
      (typeof data.currentScore !== 'number' || !Number.isFinite(data.currentScore) || data.currentScore < conditions.score_threshold)) return false;
  return true;
}
