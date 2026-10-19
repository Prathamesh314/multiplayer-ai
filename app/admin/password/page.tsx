import { redirect } from "next/navigation";
import { currentAdmin } from "../../lib/admin/auth";
import { AdminPassword } from "../../components/admin/AdminPassword";

export const dynamic = "force-dynamic";

export default async function AdminPasswordPage() {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");
  return <AdminPassword email={admin.email} required={admin.mustChangePassword} />;
}
