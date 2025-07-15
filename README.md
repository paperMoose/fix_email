# Gmail Email Filter & Analyzer

A Node.js application that connects to your Gmail account, analyzes your emails, and helps you automatically filter out unwanted messages while preserving important ones from VIP contacts.

## Important: Claude Code Integration

This tool works best when used with [Claude Code](https://github.com/anthropics/claude-code). To get the most accurate email categorization:

1. Run the email analyzer to generate an analysis report
2. Copy and paste your email analysis results into Claude Code
3. Claude Code will help you identify patterns and create optimal filtering rules
4. Apply the refined rules back to your Gmail account

This approach ensures more intelligent email categorization based on actual content patterns rather than simple keyword matching.

## Features

- **Email Analysis**: Fetches and analyzes your recent emails to identify patterns
- **VIP Protection**: Ensures emails from your VIP list are never filtered
- **Smart Categorization**: Automatically identifies:
  - Newsletters
  - Promotional emails
  - Social media notifications
  - Forum updates
  - Automated system emails
  - Personal correspondence
- **Automated Filtering**: Creates labels and filters to organize your inbox
- **Bulk Actions**: Archives unwanted emails automatically

## Prerequisites

- Node.js (v14 or higher)
- A Google account with Gmail
- Google Cloud Platform project with Gmail API enabled

## Setup

### 1. Clone the repository
```bash
git clone https://github.com/yourusername/email-filter.git
cd email-filter
```

### 2. Install dependencies
```bash
npm install
```

### 3. Set up Gmail API credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the Gmail API:
   - Navigate to "APIs & Services" > "Library"
   - Search for "Gmail API"
   - Click on it and press "Enable"
4. Create credentials:
   - Go to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "OAuth client ID"
   - Choose "Desktop app" as the application type
   - Download the credentials
5. Save the downloaded file as `credentials.json` in the project root

### 4. Configure VIP emails (optional)

Create a `.env` file based on `.env.example`:
```bash
cp .env.example .env
```

Edit `.env` and add your VIP email addresses:
```
GMAIL_USER=rbrand810@gmail.com
VIP_EMAILS=important@person.com,boss@company.com,family@member.com
```

## Usage

### Run the complete email filtering process:
```bash
npm start
```

This will:
1. Authenticate with Gmail
2. Fetch your recent emails (default: 500)
3. Analyze email patterns
4. Display a summary of findings
5. Ask for confirmation before applying filters
6. Create labels and organize your inbox

### What gets filtered:

- **Archived automatically**: Newsletters, promotional emails, automated notifications
- **Labeled but kept in inbox**: Social media, forum notifications
- **Protected**: All VIP emails are labeled and never archived

## File Structure

```
email-filter/
├── src/
│   ├── auth.js          # Gmail API authentication
│   ├── emailAnalyzer.js # Email analysis logic
│   ├── emailFilter.js   # Filtering and labeling logic
│   └── index.js         # Main application entry
├── analysis-results/    # Saved analysis reports
├── credentials.json     # Google API credentials (not in git)
├── token.json          # Auth token (generated, not in git)
├── .env                # Environment variables (not in git)
├── .env.example        # Example environment file
├── package.json        # Project dependencies
└── README.md          # This file
```

## Safety Features

- **Read-only analysis first**: The tool analyzes before making any changes
- **Confirmation required**: You must confirm before filters are applied
- **VIP protection**: VIP emails are never archived or filtered out
- **Reversible**: All actions create labels; you can manually undo changes

## Troubleshooting

### "invalid_grant" error
Delete `token.json` and run the application again to re-authenticate.

### Can't find credentials.json
Make sure you've downloaded the OAuth credentials from Google Cloud Console and saved them as `credentials.json` in the project root.

### No emails being fetched
Check that your Gmail account has emails and that the API has proper permissions.

## Future Enhancements

- Custom filtering rules
- Scheduled automatic runs
- More granular VIP settings
- Undo functionality
- Email statistics dashboard