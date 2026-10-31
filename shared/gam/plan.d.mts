export class GamError extends Error { status:number; constructor(message:string,status?:number); }
export type GamRow={name:string;code:string;sizes:string;description:string;mapKey?:string};
export function parseSizes(value:string):{sizes:{width:number;height:number}[];fluid:boolean;label:string};
export function expandGroup(group:{count:number;start:number;pattern:string;names?:string;sizes:string;description?:string;mapKey?:string}):GamRow[];
export function normalizePlan(value:unknown):{networkCode:string;parent:{mode:string;id?:string;name?:string;code?:string};rows:GamRow[];siteLabel:string;siteId?:string};
