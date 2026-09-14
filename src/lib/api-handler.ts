import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { AppError, errorResponseBody } from "@/lib/errors";

export interface AuthedContext {
  userId: string;
  emailConfirmed: boolean;
}

type RouteContext<P extends Record<string, string> = Record<string, string>> = {
  params: Promise<P>;
};

type AuthedHandler<P extends Record<string, string> = Record<string, string>> = (
  req: NextRequest,
  ctx: RouteContext<P>,
  auth: AuthedContext,
) => Promise<NextResponse>;

export interface WithAuthOptions {
  /** Chặn tính năng AI khi email chưa confirm (vd soniox-key — route tốn phí mở connection ASR). */
  requireEmailConfirmed?: boolean;
}

/**
 * Wrapper chuẩn cho route handler: xác thực session (401 nếu chưa đăng
 * nhập), convert AppError → response {error:{code,message}}, log lỗi không
 * mong đợi → 500. Route skeleton P02 chỉ trả notImplemented() bên trong.
 */
export function withAuth<P extends Record<string, string> = Record<string, string>>(
  handler: AuthedHandler<P>,
  options: WithAuthOptions = {},
) {
  return async (req: NextRequest, ctx: RouteContext<P>): Promise<NextResponse> => {
    try {
      const supabase = await createServerSupabaseClient();
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user) {
        return NextResponse.json(errorResponseBody("unauthorized", "Chưa đăng nhập"), { status: 401 });
      }

      const emailConfirmed = data.user.email_confirmed_at != null;
      if (options.requireEmailConfirmed && !emailConfirmed) {
        return NextResponse.json(
          errorResponseBody("email_not_confirmed", "Cần xác nhận email trước khi dùng tính năng AI"),
          { status: 403 },
        );
      }

      return await handler(req, ctx, { userId: data.user.id, emailConfirmed });
    } catch (err) {
      if (err instanceof AppError) {
        return NextResponse.json(errorResponseBody(err.code, err.message), { status: err.statusCode });
      }
      console.error("[api] lỗi không mong đợi", err);
      return NextResponse.json(errorResponseBody("internal_error", "Lỗi hệ thống"), { status: 500 });
    }
  };
}

/** 501 chuẩn cho endpoint chưa implement — body {error:{code:'not_implemented'}}. */
export function notImplemented(): NextResponse {
  return NextResponse.json(errorResponseBody("not_implemented", "Chưa triển khai"), { status: 501 });
}
