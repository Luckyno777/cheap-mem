// Stub declarations so tsc runs without @types/node (no dependency
// of any kind is added to this repo; the type check runs via npx only).
// Consequence, stated plainly: everything from node:* and the Node
// globals is `any` here. tsc checks the local logic of the opted-in
// files, not their use of the Node API.
declare module 'node:*';
declare const process: any;
declare const Buffer: any;
declare const console: any;
declare function setTimeout(...a: any[]): any;
declare function clearTimeout(...a: any[]): any;
declare function setInterval(...a: any[]): any;
declare function clearInterval(...a: any[]): any;
declare function setImmediate(...a: any[]): any;
declare function structuredClone(v: any): any;
interface ImportMeta { url: string; dirname: string; filename: string }
