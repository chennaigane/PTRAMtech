import {readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve as pathResolve} from 'node:path';
import ts from 'typescript';
export async function resolve(specifier,context,next){
 if(specifier.startsWith('@/'))return {url:pathToFileURL(pathResolve(specifier.slice(2)+'.ts')).href,shortCircuit:true};
 return next(specifier,context);
}
export async function load(url,context,next){if(url.endsWith('.ts'))return {format:'module',source:ts.transpileModule(await readFile(fileURLToPath(url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText,shortCircuit:true};return next(url,context);}
