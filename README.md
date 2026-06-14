# PrizePicks Backend

AWS SAM backend for PrizePicks — Node.js 20, Lambda (arm64), API Gateway HTTP API, PostgreSQL via Elastic IP, eu-west-3.

## Prerequisites

- AWS CLI configured
- AWS SAM CLI installed
- Node.js 20
- PostgreSQL client (`psql`)

## Install

```bash
cd layers/common
npm install
cd ../..
```

## SSM Parameters (create once)

```bash
aws ssm put-parameter --name /prizepicks/db/url     --value "postgresql://ppuser:PASSWORD@ELASTIC_IP:5432/prizepicks" --type SecureString --region eu-west-3
aws ssm put-parameter --name /prizepicks/jwt/secret  --value "YOUR_JWT_SECRET"   --type SecureString --region eu-west-3
aws ssm put-parameter --name /prizepicks/api_football/key --value "YOUR_API_KEY" --type SecureString --region eu-west-3
aws ssm put-parameter --name /prizepicks/stripe/secret   --value "sk_live_..."   --type SecureString --region eu-west-3
```

## Run locally

```bash
sam build
sam local start-api
```

## Run migration via SSM port forwarding

```bash
# 1. Start SSM tunnel to the EC2 hosting PostgreSQL
aws ssm start-session \
  --target INSTANCE_ID \
  --document-name AWS-StartPortForwardingSession \
  --parameters "portNumber=5432,localPortNumber=5432" \
  --region eu-west-3

# 2. In a new terminal, run the migration
psql -h localhost -U ppuser -d prizepicks -f migrations/001_init.sql
```

## Deploy

```bash
sam build
sam deploy \
  --guided \
  --stack-name prizepicks-backend-prod \
  --region eu-west-3 \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM
```

## Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | /auth/register | Register new user | None |
| POST | /auth/login | Login and get JWT | None |
| GET | /leagues | List user's leagues | JWT |
| POST | /leagues | Create a league | JWT |
| GET | /leagues/{id} | Get league detail + standings | JWT |
| PUT | /leagues/{id} | Update league (creator only) | JWT |
| POST | /leagues/join/{code} | Join league by invite code | JWT |
| GET | /leagues/{id}/standings | League standings table | JWT |
| GET | /gameweeks | List active gameweeks | JWT |
| GET | /gameweeks/{id} | Gameweek detail with events | JWT |
| POST | /picks | Submit 6-pick card | JWT |
| GET | /picks/{gameweekId} | Get user's picks for gameweek | JWT |
| GET | /matchups/{id} | Matchup detail with projected scores | JWT |
| POST | /scoring/resolve | Resolve gameweek results | JWT (admin) |
| GET | /energy | Energy balance + transactions | JWT |
| POST | /energy/buy | Create Stripe PaymentIntent | JWT |
| GET | /admin/fixtures | Import fixtures from API-Football | JWT (admin) |
| POST | /admin/gameweek | Create gameweek with events | JWT (admin) |
| POST | /admin/publish | Publish gameweek + generate matchups | JWT (admin) |

## Architecture

```
API Gateway HTTP API (eu-west-3)
  └── Lambda Functions (arm64, nodejs20.x)
        └── CommonLayer (pg, jwt, axios, bcryptjs, stripe, uuid)
              └── SSM Parameter Store (secrets)
                    └── PostgreSQL on EC2 via Elastic IP (no VPC needed)
```

## Energy System

- New users start with **5 energy units**
- Each pick has an energy_cost (1–9) based on probability
- Max 30 energy units per card (6 picks)
- Win a matchup → earn **1 energy unit**
- Buy energy packs via Stripe:
  - Starter: 4 units — €3.99
  - Value: 10 units — €7.99
  - Pro: 20 units — €14.99
