'use strict';
/**
 * Pure index contract, consumed by the VS Code workspace adapter.
 * All offsets are UTF-16, ends exclusive; uri/root are URI strings, not fs paths.
 * Existing Analysis/IRSymbol types are documented in src/contracts.js.
 *
 * new WorkspaceIndex()
 * index.upsert(uri:string,text:string,{root:string,version?:number}):IndexedDocument
 * index.get(uri):IndexedDocument|undefined
 * index.remove(uri):void; index.clear():void; index.documents():IndexedDocument[]
 * index.definitions(uri,offset):Target[]  // definitions preferred, declarations fallback
 * index.references(uri,offset,includeDeclaration=true):Target[]
 * index.completions(uri,offset):Target[] // exported module symbols absent in current file
 * index.search(query,root?):Target[]
 * index.rename(uri,offset,newName):{edits:RenameEdit[],error?:string}|undefined
 *   undefined for non-global or unresolved targets (adapter retains local rename).
 *   On error edits is empty. Never apply partial edits.
 *
 * IndexedDocument = {uri:string,root:string,text:string,version?:number,analysis:Analysis}
 * Target = {uri:string,start:number,end:number,symbol:IRSymbol}
 * RenameEdit = {uri:string,start:number,end:number,newText:string}
 *
 * Library module:
 * lookupLibrary(name:string,symbol?:IRSymbol):LibraryEntry|undefined
 * listLibraries():LibraryEntry[]
 * LibraryEntry = {name:string,category:'libc'|'intrinsic',summary:string,
 *   parameters:Array<{name:string,description:string}>,returns:string,
 *   notes:string[],url:string,details?:string}
 * details is curated Markdown (e.g. a printf format table), never source-derived.
 * No ABI signature synthesis, auto-declarations, or format-string diagnostics.
 */
module.exports = {};
