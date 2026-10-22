# Provider eligibility

- Discover from official provider APIs where available, and retain timestamped evidence for model capability, exact account tier, pricing, quota semantics, commercial-use eligibility, data handling, region restrictions, and expiry.
- Unknown or stale price, quota, or terms evidence makes an offer ineligible. A public model listing does not prove that the configured account may use it without cost or for this product.
- Require fresh positive and negative capability probes. Reject malformed, throttled, or inaccurate candidates.
- Keep each provider's fallback disabled unless the product has an explicit, bounded policy proving that fallback cannot incur unintended charges. Never rotate accounts or route around provider limits.
- Bound attempts, tokens, and output size. Record provider/model, role, attempts, latency, and reported usage; show usage as unknown when the provider does not report it.
- Consult current official provider terms before enabling offers. In particular, preserve the evaluation-only restriction on trial access unless separate production rights are verified.
