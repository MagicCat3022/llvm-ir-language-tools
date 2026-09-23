'use strict';
/**
 * Shared contracts. All modules are CommonJS, all offsets are zero-based UTF-16,
 * all end offsets are exclusive. No VS Code dependency in pure modules.
 *
 * @typedef {{start:number,end:number}} Span
 * @typedef {Span & {text:string,kind:'identifier'|'word'|'number'|'string'|'comment'|'punctuation'}} Token
 * @typedef {{name:string,type:string,start:number,end:number}} Parameter
 * @typedef {Span & {name:string,kind:'function'|'global'|'type'|'parameter'|'variable'|'label'|'metadata'|'attribute',type:string,scope:string|null,definition:string,fullStart:number,fullEnd:number,parameters?:Parameter[],returnType?:string,variadic?:boolean,declaration?:boolean}} IRSymbol
 * Symbol.name includes @/%/!/# sigils, labels are stored with a % prefix.
 * Symbol.start/end span the written definition name, labels exclude colon.
 * Symbol.scope is the function's @name for locals/parameters/labels, null for globals.
 * Symbol.type is 'unknown' when unsupported, never an invented type.
 * Function .type is its function type; .returnType is actual returned type.
 *
 * @typedef {{name:string,start:number,end:number,bodyStart:number,bodyEnd:number,symbol:IRSymbol}} IRFunction
 * @typedef {{text:string,tokens:Token[],symbols:IRSymbol[],functions:IRFunction[]}} Analysis
 *
 * analysis.js exports:
 * analyze(text:string):Analysis
 * tokenAt(analysis:Analysis,offset:number):Token|undefined
 * symbolAt(analysis:Analysis,offset:number):IRSymbol|undefined
 * references(analysis:Analysis,symbol:IRSymbol,includeDeclaration?:boolean):Span[]
 * visibleSymbols(analysis:Analysis,offset:number):IRSymbol[]
 * callAt(analysis:Analysis,offset:number):{symbol:IRSymbol,activeParameter:number,start:number,end:number}|undefined
 * formatIR(text:string,options?:{tabSize?:number,insertSpaces?:boolean}):string
 *
 * knowledge.js exports:
 * entries:Record<string,{summary:string,syntax?:string,details?:string,url:string,kind:'instruction'|'keyword'|'type'|'attribute'}>
 * lookup(word:string):{summary:string,syntax?:string,details?:string,url:string,kind:string}|undefined
 * details is optional curated Markdown, never derived from document text.
 *
 * diagnostics.js exports:
 * verifyIR(text:string,options?:{executable?:string,timeoutMs?:number,signal?:AbortSignal}):Promise<Verification>
 * parseDiagnostics(stderr:string,text:string):Issue[]
 * @typedef {{start:number,end:number,message:string,severity:'error'|'warning'}} Issue
 * @typedef {{issues:Issue[],unavailable?:string,cancelled?:boolean}} Verification
 * Do not execute a shell. Use stdin, disposable temp output or platform null device.
 * Default executable llvm-as; timeout and process/output limits required.
 */
module.exports = {};
