# AI Art Studio Security Incident Response

Last updated: 2026-05-03

This document defines the minimum response process for suspected unauthorized access, disclosure, loss, or misuse of merchant or customer personal data processed by AI Art Studio.

## Scope

Covered systems include:

- Railway application and PostgreSQL environments.
- Shopify app credentials, OAuth tokens, webhooks, and app configuration.
- Stripe Checkout/session metadata used for credit purchases.
- Object storage used for generated artwork and mockups.
- GitHub repositories, deployment credentials, and CI/deployment logs.

## Response Roles

- Incident owner: app operator / repository owner.
- Technical lead: app operator or delegated engineer with production access.
- Merchant communications owner: app operator or delegated support contact.

Only people who need production access to investigate or remediate an incident should be granted access.

## Severity Levels

- Sev 1: confirmed unauthorized access to customer personal data, production database compromise, leaked production secrets, or active attacker access.
- Sev 2: suspected unauthorized access, accidental exposure of limited personal data, or compromised non-production credential with possible production path.
- Sev 3: vulnerability report or suspicious activity without confirmed personal data exposure.

## Response Procedure

1. Triage
   - Record discovery time, reporter, systems involved, and suspected data categories.
   - Preserve relevant logs before rotation where practical.
   - Classify severity and identify immediate containment actions.

2. Containment
   - Revoke or rotate impacted credentials: Shopify app secrets, Railway variables, database passwords, Stripe keys, Supabase/object storage keys, and GitHub tokens as needed.
   - Disable affected integrations or endpoints if they continue to expose data.
   - Block suspicious IPs or sessions where supported.

3. Investigation
   - Determine affected shops, customers, tables, files, time window, and data categories.
   - Review Railway deploy history, application logs, database access, Git commits, Shopify webhook activity, and Stripe event logs.
   - Confirm whether data was accessed, exfiltrated, altered, or deleted.

4. Eradication and Recovery
   - Patch vulnerable code or configuration.
   - Redeploy from a reviewed commit.
   - Restore data from encrypted backups only when needed and only after the root cause is remediated.
   - Verify app health, webhooks, discount functions, OAuth, and customer credit behavior.

5. Notification
   - Notify impacted merchants without undue delay when customer personal data is confirmed to be affected.
   - Notify Shopify through required Partner/app channels when Shopify customer data is affected.
   - Meet applicable legal notification requirements, including GDPR-style 72-hour assessment timelines when relevant.

6. Post-Incident Review
   - Document root cause, impact, timeline, remediation, and preventive follow-ups.
   - Add tests, monitoring, runbooks, or access restrictions that would have prevented or shortened the incident.

## Preventive Controls

- Production access is limited to authorized operators.
- Secrets are stored in platform environment variables, not in source control.
- Application traffic uses HTTPS.
- PostgreSQL and platform backups are encrypted at rest by the hosting provider.
- Shopify webhook HMAC verification is required for privacy and app lifecycle webhooks.
- Customer data deletion is handled by Shopify GDPR webhook endpoints.
