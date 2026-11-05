/** Source-only planning and preservation checks; never executes test modules. */
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(process.argv[3] ?? '.');
const META = join(import.meta.dir, 'test-shards-baseline.json');
export const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const walk = (dir: string): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true }).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).flatMap(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
const testPath = (p: string) => /[._](test|spec)\.[cm]?[jt]sx?$/.test(p);
const source = (p: string) => ts.createSourceFile(p, read(p), ts.ScriptTarget.Latest, true);
const canonical = (p: string) => p === 'test/retarget-later.test.ts' ? 'test/retarget.test.ts' : p;

interface Baseline {
  files: Record<string, number>;
  beforeMs: Record<string, number>;
  order: string[];
  generatedImports: Record<string, string[]>;
}
interface Block { file: string; name: string; sha256: string }
interface Preservation { imports: string[]; reexports: string[]; fixtureImports: Record<string, string>; hook: string; declarations: {sha256: string}[]; blocks: Block[] }
const fail = (code: string, detail: string): never => { throw Error(`${code}: ${detail}`); };
const call = (s: ts.Statement) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) ? s.expression : undefined;

function preserve(): void {
  const frozen = JSON.parse(readFileSync(join(import.meta.dir, 'test-shards-preservation.json'), 'utf8')) as Preservation;
  const fixture = source('test/retarget-fixture.ts');
  const imports: string[] = [], exports: string[] = [], declarations: string[] = [];
  for (const s of fixture.statements) {
    if (ts.isImportDeclaration(s)) imports.push(s.getText(fixture));
    else if (ts.isExportDeclaration(s)) exports.push(s.getText(fixture));
    else if (ts.isVariableStatement(s) || ts.isFunctionDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) {
      const text = s.getText(fixture);
      if (!text.startsWith('export ')) fail('DECLARATION_EXPORT', text.slice(0, 70));
      declarations.push(sha(text.slice('export '.length)));
    } else fail('FIXTURE_REGISTRATION', s.getText(fixture).slice(0,100));
  }
  if (JSON.stringify(imports)!==JSON.stringify(frozen.imports) || JSON.stringify(exports)!==JSON.stringify(frozen.reexports)) fail('FIXTURE_IMPORTS', 'original imports or permitted reexports changed');
  if (JSON.stringify(declarations)!==JSON.stringify(frozen.declarations.map(d=>d.sha256))) fail('DECLARATION_BYTES', 'only added export keywords may differ; order/count must match');
  const actual: Block[] = [];
  for (const file of ['test/retarget.test.ts', 'test/retarget-later.test.ts']) {
    const sf=source(file); let nImports=0, hooks=0;
    for (const s of sf.statements) {
      if(ts.isImportDeclaration(s)) {
        nImports++; if(s.getText(sf)!==frozen.fixtureImports[file])fail('TEST_IMPORT',file);
        continue;
      }
      const c=call(s);const name=c?.expression.getText(sf);
      if(name==='afterEach') { hooks++;if(s.getText(sf)!==frozen.hook)fail('HOOK_BYTES',file); }
      else if(c && (name==='describe'||name==='test') && c.arguments[0] && ts.isStringLiteral(c.arguments[0])) actual.push({file,name:c.arguments[0].text,sha256:sha(s.getText(sf))});
      else fail('TEST_TOP_LEVEL',`${file}: only the fixture import, original hook, and whole blocks are allowed`);
    }
    if(nImports!==1||hooks!==1)fail('HOOK_COUNT',`${file}: imports ${nImports}, hooks ${hooks}; required 1 each`);
  }
  // Exact arrays preserve the multiset, names, order, ownership and absence of extras.
  const expected=frozen.blocks.map(({file,name,sha256})=>({file,name,sha256}));
  if(JSON.stringify(actual)!==JSON.stringify(expected))fail('BLOCK_BYTES_NAMES', 'whole-block SHA/name/order/file multiset differs from the accepted freeze');
  console.log(`PRESERVED ${actual.length} whole blocks, ${declarations.length} declarations, two original drain hooks; fixture registers no tests/hooks`);
}

function plan(): void {
  const baseline=JSON.parse(readFileSync(META,'utf8')) as Baseline;
  const files=walk('test').filter(testPath).sort(); if(!files.length)fail('NO_TEST_FILES','test tree is empty');
  const nodes=new Map<string,string[]>();
  const parse=(file:string):void=>{
    if(nodes.has(file))return; const edges:string[]=[];nodes.set(file,edges);const sf=source(file);
    const edge=(specifier:string)=>{
      if(!specifier.startsWith('.'))return;
      const path=resolve(ROOT,dirname(file),specifier);
      const candidates=[path,path+'.ts',path+'.tsx',path+'.js',join(path,'index.ts'),join(path,'index.js')];
      const found=candidates.find(p=>{try{return readFileSync(p).length>=0;}catch{return false;}});
      if(!found)fail('IMPORT_UNAVAILABLE',`${file}: ${specifier}`);
      const rel=relative(ROOT,found!).split('\\').join('/');
      if(rel.startsWith('../'))fail('IMPORT_OUTSIDE_TREE',`${file}: ${specifier}`);
      if(/\.[cm]?[jt]sx?$/.test(rel)){edges.push(rel);parse(rel);}
    };
    const visit=(n:ts.Node)=>{
      if(ts.isImportDeclaration(n)&&ts.isStringLiteral(n.moduleSpecifier)) {
        const clause=n.importClause;
        const onlyTypes=clause?.isTypeOnly || (clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.name && clause.namedBindings.elements.every(e=>e.isTypeOnly));
        if(!onlyTypes)edge(n.moduleSpecifier.text);
      } else if(ts.isExportDeclaration(n)&&!n.isTypeOnly&&n.moduleSpecifier&&ts.isStringLiteral(n.moduleSpecifier))edge(n.moduleSpecifier.text);
      else if(ts.isCallExpression(n)&&(n.expression.kind===ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression)&&n.expression.text==='require'))) {
        const arg=n.arguments[0];
        if(arg && (ts.isStringLiteral(arg)||ts.isNoSubstitutionTemplateLiteral(arg)))edge(arg.text);
        else if(!(baseline.generatedImports[canonical(file)]??[]).includes(sha(n.getText(sf))))fail('UNRESOLVED_IMPORT',`${file}: nonliteral module load is not a frozen generated-fixture import`);
      }
      ts.forEachChild(n,visit);
    };visit(sf);
  };
  for(const file of files)parse(file);
  const parents=new Map(files.map(f=>[f,f]));
  const find=(f:string):string=>{const p=parents.get(f)!;return p===f?f:find(p);};
  for(const file of files){
    const seen=new Set<string>();const visit=(p:string)=>{if(seen.has(p))return;seen.add(p);if(parents.has(p))parents.set(find(p),find(file));for(const next of nodes.get(p)??[])visit(next);};visit(file);
  }
  const groups=new Map<string,string[]>();for(const f of files){const g=find(f);groups.set(g,[...(groups.get(g)??[]),f]);}
  const measured=Object.values(baseline.beforeMs).sort((a,b)=>a-b);
  if(!measured.length)fail('NO_MEASURED_WEIGHTS','baseline has no native file timings');
  const middle=Math.floor(measured.length/2);
  const fallback=measured.length%2 ? measured[middle]! : (measured[middle-1]!+measured[middle]!)/2;
  const weight=(g:string[])=>g.reduce((n,f)=>n+(baseline.files[f]??fallback),0);
  const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
  const components=[...groups.values()].map(g=>g.sort());
  components.sort((a,b)=>weight(b)-weight(a)||compare(a[0]!,b[0]!));
  const shards=Array.from({length:3},(_,i)=>({id:i+1,files:[] as string[],weightMs:0}));
  for(const g of components){const target=[...shards].sort((a,b)=>a.weightMs-b.weightMs||a.id-b.id)[0]!;target.files.push(...g);target.weightMs+=weight(g);}
  const order=new Map(baseline.order.map((f,i)=>[f,i]));
  for(const shard of shards)shard.files.sort((a,b)=>(order.get(a)??Infinity)-(order.get(b)??Infinity)||compare(a,b));
  const inputs=Object.fromEntries([...walk('test'),...walk('src'),...walk('examples'),'cli.ts','package.json','bun.lock'].sort().map(f=>[f,sha(readFileSync(join(ROOT,f)))]));
  const body={files,components,shards,inputs,unmeasured:files.filter(f=>!(f in baseline.files)),unmeasuredSchedulingPolicy:{name:'median of measured native baseline file weights',weightMs:fallback}};
  const digest=sha(JSON.stringify(body));
  const output={...body,digest};
  if(process.argv[4])writeFileSync(process.argv[4],JSON.stringify(output,null,2)+'\n');else console.log(JSON.stringify(output));
}

try {
  if(process.argv[2]==='inspect')preserve();
  else if(process.argv[2]==='plan')plan();
  else fail('COMMAND','use inspect (raw migration inspector) or plan');
} catch(error) {console.error(error instanceof Error?error.message:String(error));process.exit(1);}
