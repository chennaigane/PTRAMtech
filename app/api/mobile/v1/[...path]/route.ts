import {mobileRequest} from '@/lib/mobile-api';

export const runtime = 'nodejs';
export async function POST(req: Request) { return mobileRequest(req); }
