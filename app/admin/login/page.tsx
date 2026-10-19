import { redirect } from "next/navigation";
import { currentAdmin } from "../../lib/admin/auth";
import { AdminLogin } from "../../components/admin/AdminLogin";

export const dynamic = "force-dynamic";

export default async function AdminLoginPage() {
  if (await currentAdmin()) redirect("/admin");
  return <AdminLogin />;
}
