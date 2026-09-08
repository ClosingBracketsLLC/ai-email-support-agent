/**
 * Round-robin selection across organizations: number rows per org, then take by rank so no org can
 * occupy a whole sweep. `from`, `where` and `orderBy` are TRUSTED SQL fragments written by our code,
 * never user input; `limit` is a bound parameter.
 */
export function fairSelectSql(p: { from: string; where: string; orderBy: string; limit: number }): { text: string; values: unknown[] } {
  return {
    text: `SELECT * FROM (
             SELECT t.*, ROW_NUMBER() OVER (PARTITION BY org_id ORDER BY ${p.orderBy}) AS rn
             FROM ${p.from} t WHERE ${p.where}
           ) s ORDER BY rn, ${p.orderBy} LIMIT $1`,
    values: [p.limit],
  }
}
