import { EmptyState } from "@/components/foundation/states";
import { PageHeader } from "@/components/foundation/page-header";

export function PlaceholderPage({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="space-y-6">
      <PageHeader title={title} description={description} />
      <EmptyState
        title={`${title} foundation ready`}
        description="This workspace is ready for the next operations workflow. No production records are requested or displayed yet."
      />
    </div>
  );
}
