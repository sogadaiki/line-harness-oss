import { HTTPException } from 'hono/http-exception';
import { getLineAccountById } from '@line-crm/db';

/** A browser-supplied LINE ID is not proof of ownership. Verify against that OA's login channel. */
export async function verifyAccountIdentity(db:D1Database,accountId:string,idToken:unknown,expectedUserId?:string):Promise<string> {
  if (typeof idToken !== 'string' || !idToken) throw new HTTPException(401,{message:'LINE ID token is required'});
  const account=await getLineAccountById(db,accountId);
  if (!account?.is_active || !account.login_channel_id) throw new HTTPException(403,{message:'LINE Login is unavailable for this account'});
  const response=await fetch('https://api.line.me/oauth2/v2.1/verify',{
    method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({id_token:idToken,client_id:account.login_channel_id}),
  });
  if (!response.ok) throw new HTTPException(401,{message:'Invalid LINE ID token'});
  const verified=await response.json() as {sub?:string};
  if (!verified.sub || (expectedUserId && verified.sub !== expectedUserId)) throw new HTTPException(403,{message:'LINE identity mismatch'});
  return verified.sub;
}
