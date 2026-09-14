import { redirect } from "next/navigation";

/** /admin → /admin/users (trang duy nhất phase 01; guard nằm ở layout). */
export default function AdminIndexPage() {
  redirect("/admin/users");
}
