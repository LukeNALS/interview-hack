import { LiveScreen } from "@/components/live/live-screen";
import { SessionScreenGuard } from "../session-screen-guard";

interface PageProps {
  params: Promise<{ id: string }>;
}

/** Màn Trong buổi phỏng vấn — transcript realtime 3 cột (mock playback P03). */
export default async function SessionLivePage({ params }: PageProps) {
  const { id } = await params;
  return (
    <SessionScreenGuard sessionId={id} screen="live">
      <LiveScreen sessionId={id} />
    </SessionScreenGuard>
  );
}
