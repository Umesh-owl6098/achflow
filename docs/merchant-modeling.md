# Merchant modeling

Merchant records own payments and enforce their active status, ACH-direction permissions, and per-payment limit during payment validation. `dailyAmountLimit` is stored now but is intentionally not enforced until the next phase can calculate daily usage transactionally across concurrent payments.
