import { DatabaseSync } from 'node:sqlite';
// Real SQLite transactions behind the narrow D1 interface; no fake limiter result.
export function loginStore(path = ':memory:') {
  const sqlite = new DatabaseSync(path);
  const DB = {
    prepare(sql) {
      const statement = args => ({sql,args,bind(...values){return statement(values);},async first(){return sqlite.prepare(sql).get(...args) ?? null;}});
      return statement([]);
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results=statements.map(({sql,args})=>{
          const statement=sqlite.prepare(sql);
          if(statement.columns().length)return {success:true,results:statement.all(...args)};
          statement.run(...args);return {success:true,results:[]};
        });
        sqlite.exec('COMMIT');return results;
      } catch(e){sqlite.exec('ROLLBACK');throw e;}
    },
  };
  return {DB,sqlite,close(){sqlite.close();}};
}
