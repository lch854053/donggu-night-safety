export interface PoliceRow {
  시도청: string;
  주소: string;
  경찰서?: string;
  관서명: string;
  구분?: string;
  치안센터명?: string;
  연번: number;
}
export const POLICE_APIS: { path: string; kind: string }[];
export function isDongguPolice(row: PoliceRow): boolean;
export function policeName(row: PoliceRow, kind: string): string;
export function normalizeAddress(address: string): string;
export function fetchPoliceRows(key: string, request?: typeof fetch): Promise<{ row: PoliceRow; kind: string; source: string }[]>;
export function geocodePolice(row: PoliceRow, kind: string, kakaoKey?: string, request?: typeof fetch): Promise<number[] | null>;
