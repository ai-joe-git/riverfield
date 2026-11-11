/** Resolve catalog IDs or unique display names, never fuzzy guesses or aliases. */
export function resolveApp<T extends {id:string;name:string}>(apps:T[],reference:string):T{
 const exact=apps.find(a=>a.id===reference);if(exact)return exact;
 const key=(value:string)=>value.normalize("NFKC").trim().toLowerCase().replace(/[\s_-]+/g," ");
 const matches=apps.filter(a=>key(a.id)===key(reference)||key(a.name)===key(reference));
 if(matches.length===1)return matches[0];
 if(matches.length>1)throw new Error(`Ambiguous app ${JSON.stringify(reference)}: use one of these IDs: ${matches.map(a=>a.id).join(", ")}`);
 throw new Error(`Unknown app ${JSON.stringify(reference)}. Read list_apps and use an installed ID or its exact display name.`);
}
