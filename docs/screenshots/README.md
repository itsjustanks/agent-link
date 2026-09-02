# Screenshots

Four panel captures, referenced from the project README:

| File | Tab | Redact before committing |
| --- | --- | --- |
| `setup.png` | Setup | — |
| `accounts.png` | Accounts | **every account email**, and the error text under a parked account if it names one |
| `models.png` | Models | — |
| `tuning.png` | Tuning | — |

Accounts is the only one carrying personal data. Black out the address rows
completely rather than blurring: a blur of short fixed-format text is often
reversible, and these are real sign-ins.

Nothing else in the panel renders a secret — the API key shows as its last four
characters, the dashboard password as dots, and model ids are public names.
