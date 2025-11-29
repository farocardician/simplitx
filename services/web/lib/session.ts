import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';

export function withSession(handler: Function) {
  return async (req: NextRequest, ...args: any[]) => {
    try {
      const sessionId = req.cookies.get('owner_session_id')?.value || randomUUID();

      const response = await handler(req, { sessionId }, ...args);

      if (!req.cookies.has('owner_session_id')) {
        response.cookies.set('owner_session_id', sessionId, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 60 * 60 * 24 * 30 // 30 days
        });
      }

      return response;
    } catch (error) {
      console.error('Session handler error:', error);
      return NextResponse.json(
        {
          error: {
            code: 'INTERNAL_ERROR',
            message: error instanceof Error ? error.message : 'An unexpected error occurred'
          }
        },
        { status: 500 }
      );
    }
  };
}