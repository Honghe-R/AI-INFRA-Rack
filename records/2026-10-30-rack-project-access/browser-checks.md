# Local Browser Acceptance — Project Access

Date: 2026-10-30. Target: `http://localhost:5193/` in the in-app browser. No teacher platform was opened. Only seeded demonstration accounts and local saved Rack plans were inspected.

1. Opened **Northern DC Campus**, navigated to **Rack**, and observed administrator capabilities: view/compute, edit/save, delete, restore and project access management.
2. Opened **Project access** without selecting a plan. The list returned Dana Whitfield (administrator), Mei Lin (viewer) and Ravi Menon (editor), each with direct role, ACTIVE membership and version 1. Dana's own Change access action was disabled with an explanation.
3. Opened Mei's form. It offered only the three project roles and Active/Suspended states, with version and last-administrator explanation. Submitted its unchanged Viewer/Active values. The interface returned **Project access was already up to date**, kept version 1 and recorded zero events. No seeded role/status changed.
4. Used the development identity menu to switch to Ravi Menon. Opened Rack → Plans → Auto Design Demo. New empty plan and Rename plan were available. Delete/Restore and Project access were absent; the capability strip showed view/compute and edit/save.
5. Switched to Mei Lin. The existing saved plan remained readable. The toolbar exposed Check results, with add/edit commands absent. New plan, Rename, Delete/Restore and Project access were absent; the strip said Read only. Both seeded demo plans remained v3.
6. Returned to Dana, reopened Rack → Project access and searched the organisation. The eligible-account selector returned Alex Okafor from the same organisation, not the second organisation's users. No add request was submitted.
7. Left the browser at the administrator Project access panel for review and marked the tab as a deliverable. Saved [admin-access.png](admin-access.png) at the ordinary narrow app viewport. No viewport override was used.

The page explicitly explains that suspension removes direct project grants while organisation/global roles may still allow access. The account switch menu already identifies its identities as development-only. Its labels remain seed metadata; actual Rack capability checks and member responses are authoritative.

Actual changing-access success/failure, concurrency, atomic audit, cross-tenant denials and backend enforcement were verified with isolated DB/HTTP fixtures. Static rendering and this narrow browser inspection do not certify complete accessibility, all screen sizes or production identity/security.
