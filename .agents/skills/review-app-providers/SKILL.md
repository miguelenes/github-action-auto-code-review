---
name: review-app-providers
description: Implement and assess provider catalog discovery and model eligibility for this project's free or trial LLM review service.
---
Discover models from official provider APIs where available and record timestamped pricing, quota, expiry, capability, and usage-term evidence. Unknown or stale prices are ineligible. Never silently fall back to paid inference. Treat trial terms as provider-specific; NVIDIA API trial access is evaluation-only unless distinct production rights are verified. Model discovery does not prove account eligibility. Consult vendor/skills/free-llm-apis/ as background, then verify current facts from official sources.
