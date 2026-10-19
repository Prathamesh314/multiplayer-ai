import { redirect } from "next/navigation";
import { currentAdmin } from "../lib/admin/auth";
import { loadDashboard } from "../lib/admin/dashboard";
import { AdminDashboard } from "../components/admin/AdminDashboard";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");
  // A password someone else chose must be replaced before anything else.
  if (admin.mustChangePassword) redirect("/admin/password");
  return <AdminDashboard data={await loadDashboard()} admin={{ email: admin.email, name: admin.displayName }} />;
}
