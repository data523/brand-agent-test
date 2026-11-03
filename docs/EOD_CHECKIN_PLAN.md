# EOD Check-in Automation Plan

## Overview
Automated end-of-day check-in bot for Slack that prompts team members for daily updates, stores responses in Google Sheets, and provides a dashboard view.

## Slack Scopes Required
| Scope | Purpose |
|-------|---------|
| `chat:write` | Post check-in prompts and reminders in DMs |
| `im:write` | Open DM channels with users |
| `users:read` | Get user list and profile info (name, timezone) |
| `im:history` | Read DM history for follow-up context |

## Google Sheets Schema (4 Tabs)

### 1. `tasks` — Task tracking
| Column | Type | Description |
|--------|------|-------------|
| `task_id` | string | UUID |
| `user_id` | string | Slack user ID |
| `user_name` | string | Display name |
| `title` | string | Task title |
| `description` | string | Details |
| `status` | enum | `pending` \| `in_progress` \| `done` \| `blocked` |
| `priority` | enum | `high` \| `medium` \| `low` |
| `created_at` | timestamp | ISO 8601 |
| `updated_at` | timestamp | ISO 8601 |
| `due_date` | date | YYYY-MM-DD |
| `tags` | string | Comma-separated |

### 2. `log` — Daily check-in responses
| Column | Type | Description |
|--------|------|-------------|
| `log_id` | string | UUID |
| `user_id` | string | Slack user ID |
| `user_name` | string | Display name |
| `date` | date | YYYY-MM-DD (IST) |
| `accomplished` | string | What was completed |
| `blockers` | string | What blocked progress |
| `next_steps` | string | Planned next actions |
| `mood` | enum | `great` \| `ok` \| `struggling` |
| `hours_focused` | number | Deep work hours |
| `submitted_at` | timestamp | ISO 8601 |

### 3. `people` — Team roster
| Column | Type | Description |
|--------|------|-------------|
| `user_id` | string | Slack user ID (PK) |
| `name` | string | Display name |
| `email` | string | Email |
| `timezone` | string | IANA timezone (e.g., `Asia/Kolkata`) |
| `role` | string | Role/title |
| `active` | boolean | Currently receiving check-ins |
| `checkin_time` | time | Preferred check-in time (HH:MM in user TZ) |
| `created_at` | timestamp | ISO 8601 |

### 4. `dashboard` — Aggregated views (formulas)
| Column | Type | Description |
|--------|------|-------------|
| `date` | date | YYYY-MM-DD |
| `team_size` | number | Active users |
| `responded` | number | Check-ins submitted |
| `pending` | number | Awaiting response |
| `avg_mood` | number | 1-3 score |
| `total_hours` | number | Sum of focused hours |
| `blockers_count` | number | Unique blockers reported |

## Cron Schedule
- **Frequency**: Weekdays (Mon-Fri)
- **Time**: 18:00 IST (12:30 UTC)
- **Implementation**: Vercel Cron Job or Supabase pg_cron

```yaml
# vercel.json
{
  "crons": [
    {
      "path": "/api/cron/eod-checkin",
      "schedule": "30 12 * * 1-5"
    }
  ]
}
```

## Flow
1. Cron triggers `/api/cron/eod-checkin` at 18:00 IST
2. Fetch active users from `people` tab
3. For each user, open DM and send check-in modal/message
4. User submits response → stored in `log` tab
5. Follow-up reminder at 20:00 IST for non-responders
6. Dashboard tab auto-updates via Google Sheets formulas

## Cost Estimate
| Component | Cost |
|-----------|------|
| Vercel Pro (for cron + functions) | $20/mo |
| Google Sheets API (within free quota) | $0 |
| Slack App (free tier) | $0 |
| Supabase (if used for auth/queue) | $0-25/mo |
| **Total** | **~$20-45/mo** |

## Test Plan
1. **Unit**: Slack modal payload construction, Sheets append/read
2. **Integration**: Full cron → DM → submit → sheet write
3. **Manual**: Install in test workspace, run cron manually, verify 3 users
4. **Edge cases**: User not in `people` tab, timezone DST, Sheets API quota

## What Uday Must Provide
- [ ] **Slack Admin Approval**: Install app with scopes above in Think Tree Media workspace
- [ ] **Google Sheet Copy**: Duplicate template sheet, share with service account
- [ ] **Google Service Account**: Create in GCP, enable Sheets API, download JSON key
- [ ] **Sheet ID**: Provide the spreadsheet ID from URL
- [ ] **Service Account Email**: Add to `GOOGLE_SERVICE_ACCOUNT_EMAIL` in Vercel
- [ ] **Private Key**: Add to `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` in Vercel (with `\n` escaped)
- [ ] **Team Roster**: Initial CSV of user_id, name, email, timezone, role
- [ ] **Preferred Check-in Time**: Default 18:00 IST or per-user override

## Security Notes
- Service account key stored in Vercel env vars (encrypted)
- Sheet shared only with service account email
- Slack signing secret in Vercel env vars
- Admin secret protects cron endpoint

## Next Steps
1. Create Slack app manifest with scopes
2. Build `/api/cron/eod-checkin` endpoint
3. Build Google Sheets service module
4. Create Google Sheet template with 4 tabs
5. Deploy to preview, test with 2 users
6. Uday approves in production workspace