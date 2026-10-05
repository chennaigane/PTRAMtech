import {DatabaseSetupError,DatabaseUnavailableError} from '@/db/raw';

export function authFailure(error:unknown,fallback:string) {
  console.error(error);
  if(error instanceof DatabaseSetupError) return Response.json({code:'DATABASE_NOT_CONFIGURED',error:'Account storage is not configured. The administrator must finish database setup before sign-in or Admin setup can work.'},{status:503});
  if(error instanceof DatabaseUnavailableError) return Response.json({code:'DATABASE_UNAVAILABLE',error:'Account storage is unavailable. The administrator must check the database connection settings, availability and permissions.'},{status:503});
  return Response.json({error:fallback},{status:503});
}
