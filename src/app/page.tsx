import { redirect } from "next/navigation";
import { LandingScreen } from "@/components/landing/landing-screen";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * `/` — landing page cho khách lạ. User đã đăng nhập về thẳng /candidate
 * (landing chỉ để giới thiệu + kéo signup; middleware đã mở `/` thành public path).
 */
export default async function Home() {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.auth.getUser();
  if (data.user) redirect("/candidate");
  return <LandingScreen />;
}
