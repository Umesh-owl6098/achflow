import { PageHeader } from "@/components/foundation/page-header";
import { PaymentsTable } from "@/components/payments/payments-table";

export default function PaymentsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Payments"
        description="Search, review, and monitor ACH payment lifecycle activity."
      />
      <PaymentsTable />
    </div>
  );
}
