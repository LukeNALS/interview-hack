import { SetupScreen } from "@/components/setup/setup-screen";
import { SessionScreenGuard } from "../session-screen-guard";

interface PageProps {
  params: Promise<{ id: string }>;
}

/** Màn Vào buổi phỏng vấn: chọn chế độ → (online) hướng dẫn chọn tab → live. */
export default async function SessionSetupPage({ params }: PageProps) {
  const { id } = await params;
  return (
    <SessionScreenGuard sessionId={id} screen="setup">
      <SetupScreen sessionId={id} />
    </SessionScreenGuard>
  );
}
