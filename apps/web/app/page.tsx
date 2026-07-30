import { PageHeader } from "@/components/foundation/page-header";
import { Dashboard } from "@/components/dashboard/dashboard";

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="A secure workspace for ACH payment operations."
      />
      <Dashboard />
    </div>
  );
}
