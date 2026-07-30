import { PaymentDetailsView } from "@/components/payments/payment-details";

export default async function PaymentPlaceholderPage({
  params,
}: {
  params: Promise<{ paymentId: string }>;
}) {
  const { paymentId } = await params;
  return <PaymentDetailsView paymentId={paymentId} />;
}
