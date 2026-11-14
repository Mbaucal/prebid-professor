import { parse } from 'acorn';
import assert from 'node:assert/strict';
/** Inspect only literal initializers in the outer generated IIFE. Never execute ads. */
export function generatedLiteral(source,name) {
  const ast=parse(source,{ecmaVersion:'latest'});
  const fn=ast.body.find((n)=>n.type==='ExpressionStatement' && n.expression?.type==='CallExpression')?.expression.callee;
  assert.equal(fn?.type,'FunctionExpression','Expected generated wrapper function');
  const declarations=fn.body.body.filter((n)=>n.type==='VariableDeclaration').flatMap((n)=>n.declarations).filter((d)=>d.id.name===name);
  assert.equal(declarations.length,1,'Expected one '+name+' initializer');
  function value(n) {
    if(n.type==='Literal'&&!n.regex)return n.value;
    if(n.type==='ArrayExpression')return n.elements.map(value);
    if(n.type==='ObjectExpression')return Object.fromEntries(n.properties.map((p)=>{
      assert.equal(p.type,'Property');assert.equal(p.kind,'init');assert.equal(p.computed,false);
      return [p.key.type==='Identifier'?p.key.name:p.key.value,value(p.value)];
    }));
    throw Error('Non-literal initializer in '+name);
  }
  return value(declarations[0].init);
}
