import { authorize } from './auth.js';
import { google } from 'googleapis';
import chalk from 'chalk';
import ora from 'ora';
import readline from 'readline/promises';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();

class LikelySpamAnalyzer {
  constructor(auth) {
    this.gmail = google.gmail({ version: 'v1', auth });
    this.vipEmails = process.env.VIP_EMAILS ? process.env.VIP_EMAILS.split(',').map(e => e.trim().toLowerCase()) : [];
    this.protectedSenders = process.env.PROTECTED_SENDERS ? process.env.PROTECTED_SENDERS.split(',').map(e => e.trim().toLowerCase()) : [];
    this.stats = {
      analyzed: 0,
      legitimate: 0,
      suspicious: 0,
      rescued: 0
    };
  }

  // Get label ID by name
  async getLabelId(labelName) {
    try {
      const response = await this.gmail.users.labels.list({ userId: 'me' });
      const label = response.data.labels.find(l => l.name === labelName);
      return label ? label.id : null;
    } catch (error) {
      console.error(`Error getting label ${labelName}:`, error.message);
      return null;
    }
  }

  // Extract email from From field
  extractEmail(fromField) {
    const match = fromField.match(/<(.+?)>/) || fromField.match(/([^\s]+@[^\s]+)/);
    return match ? match[1] : fromField;
  }

  // Check if an email is legitimate
  isLegitimate(email) {
    const fromEmail = email.fromEmail;
    const subject = email.subject.toLowerCase();

    // Check if VIP
    if (this.vipEmails.includes(fromEmail)) {
      return true;
    }

    // Check if protected sender
    if (this.protectedSenders.includes(fromEmail)) {
      return true;
    }

    // Check for legitimate services that shouldn't be in spam
    const legitimatePatterns = [
      // Banking/Financial
      /@chase\.com$/,
      /@capitalone\.com$/,
      /@mercury\.com$/,
      /@stripe\.com$/,
      /@paypal\.com$/,
      /@venmo\.com$/,
      /@coinbase\.com$/,
      /@robinhood\.com$/,
      
      // Important services
      /@apple\.com$/,
      /@google\.com$/,
      /@anthropic\.com$/,
      /@openai\.com$/,
      /@github\.com$/,
      /@gitlab\.com$/,
      
      // Healthcare
      /@sutterhealth\.org$/,
      /@myhealth/,
      /@kaiserpermanente\.org$/,
      
      // Travel
      /@united\.com$/,
      /@delta\.com$/,
      /@southwest\.com$/,
      /@airbnb\.com$/,
      /@booking\.com$/,
      
      // Work/HR
      /@rippling\.com$/,
      /@gusto\.com$/,
      /@adp\.com$/,
      
      // Delivery (order confirmations)
      /@uber\.com$/,
      /@doordash\.com$/,
      /@grubhub\.com$/,
      /@instacart\.com$/,
      
      // Utilities
      /@pge\.com$/,
      /@comcast\.com$/,
      /@att\.com$/,
      /@verizon\.com$/
    ];

    if (legitimatePatterns.some(pattern => pattern.test(fromEmail))) {
      // Extra check for transactional emails
      const transactionKeywords = ['payment', 'receipt', 'order', 'confirmation', 'invoice', 
                                   'payroll', 'benefits', 'appointment', 'reservation', 'statement',
                                   'bill', 'charged', 'refund', 'shipped', 'delivered'];
      if (transactionKeywords.some(keyword => subject.includes(keyword))) {
        return true;
      }
      
      // Service-specific checks
      if (fromEmail.includes('paypal.com') && 
          (subject.includes('payment') || subject.includes('received') || subject.includes('sent'))) {
        return true;
      }
      
      if (fromEmail.includes('rippling.com') && 
          (subject.includes('payroll') || subject.includes('benefits') || subject.includes('tax'))) {
        return true;
      }
    }

    // Check for personal emails (not from automated systems)
    if (!fromEmail.includes('noreply') && 
        !fromEmail.includes('no-reply') && 
        !fromEmail.includes('notification') &&
        !fromEmail.includes('newsletter') &&
        !fromEmail.includes('marketing') &&
        !fromEmail.includes('automated') &&
        email.from.includes('<') && // Has a personal name
        !email.from.toLowerCase().includes('team') &&
        !email.from.toLowerCase().includes('support')) {
      
      // Check if it's from a personal domain (not a service)
      const serviceDomains = ['mailchimp.com', 'sendgrid.net', 'mailgun.org', 'amazonses.com', 
                             'beehiiv.com', 'substack.com', 'constantcontact.com'];
      if (!serviceDomains.some(domain => fromEmail.includes(domain))) {
        return true; // Likely personal email
      }
    }

    return false;
  }

  // Analyze Likely Spam folder
  async analyze(limit = 5000) {
    const spinner = ora('Fetching emails from Likely Spam folder...').start();
    
    try {
      const likelySpamLabelId = await this.getLabelId('Likely Spam');
      if (!likelySpamLabelId) {
        spinner.fail('Likely Spam label not found');
        return { legitimate: [], suspicious: [], senderStats: new Map() };
      }

      // Fetch emails from Likely Spam
      const response = await this.gmail.users.messages.list({
        userId: 'me',
        labelIds: [likelySpamLabelId],
        maxResults: limit
      });

      const messages = response.data.messages || [];
      spinner.text = `Found ${messages.length} emails in Likely Spam. Analyzing...`;

      const legitimate = [];
      const suspicious = [];
      const senderStats = new Map();

      // Analyze each message
      const batchSize = 20;
      for (let i = 0; i < messages.length; i += batchSize) {
        const batch = messages.slice(i, i + batchSize);
        
        const analyses = await Promise.all(
          batch.map(async (msg) => {
            try {
              const detail = await this.gmail.users.messages.get({
                userId: 'me',
                id: msg.id,
                format: 'metadata',
                metadataHeaders: ['From', 'Subject', 'Date']
              });

              const headers = detail.data.payload.headers.reduce((acc, h) => {
                acc[h.name.toLowerCase()] = h.value;
                return acc;
              }, {});

              const from = headers.from || '';
              const subject = headers.subject || '';
              const date = headers.date || '';
              const fromEmail = this.extractEmail(from).toLowerCase();

              // Count sender frequency
              senderStats.set(fromEmail, (senderStats.get(fromEmail) || 0) + 1);

              return {
                id: msg.id,
                from,
                fromEmail,
                subject,
                date,
                labels: detail.data.labelIds || []
              };
            } catch (err) {
              return null;
            }
          })
        );

        // Classify each email
        analyses.filter(a => a).forEach(email => {
          this.stats.analyzed++;
          if (this.isLegitimate(email)) {
            legitimate.push(email);
            this.stats.legitimate++;
          } else {
            suspicious.push(email);
            this.stats.suspicious++;
          }
        });

        spinner.text = `Analyzed ${Math.min(i + batchSize, messages.length)} of ${messages.length} emails`;
      }

      spinner.succeed(`Analysis complete: ${this.stats.legitimate} potentially legitimate, ${this.stats.suspicious} confirmed spam`);
      
      return { legitimate, suspicious, senderStats };
    } catch (error) {
      spinner.fail('Failed to analyze Likely Spam');
      throw error;
    }
  }

  // Display analysis results
  displayResults(legitimate, suspicious, senderStats) {
    console.log('\n' + chalk.bold.cyan('📊 Likely Spam Analysis Results'));
    console.log(chalk.gray('='.repeat(60)));
    
    console.log(chalk.bold(`Total analyzed: ${this.stats.analyzed} emails`));
    console.log(chalk.green(`✅ Potentially legitimate: ${this.stats.legitimate}`));
    console.log(chalk.red(`❌ Confirmed spam: ${this.stats.suspicious}`));
    
    if (legitimate.length > 0) {
      console.log('\n' + chalk.bold.yellow('⚠️  Potentially Legitimate Emails Found:'));
      console.log(chalk.gray('These emails might not belong in spam:\n'));
      
      // Group by sender
      const bySender = {};
      legitimate.forEach(email => {
        if (!bySender[email.fromEmail]) {
          bySender[email.fromEmail] = [];
        }
        bySender[email.fromEmail].push(email);
      });
      
      // Show all legitimate senders
      Object.entries(bySender)
        .sort((a, b) => b[1].length - a[1].length)
        .forEach(([sender, emails]) => {
          console.log(chalk.yellow(`📧 ${sender} (${emails.length} emails)`));
          // Show sample subjects
          emails.slice(0, 3).forEach(email => {
            const subject = email.subject.length > 60 ? 
              email.subject.substring(0, 60) + '...' : email.subject;
            console.log(chalk.gray(`   • "${subject}"`));
          });
        });
    }
    
    // Show top spam senders
    console.log('\n' + chalk.bold.red('🚫 Top Spam Senders (correctly filtered):'));
    Array.from(senderStats.entries())
      .filter(([sender]) => !legitimate.some(e => e.fromEmail === sender))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .forEach(([sender, count]) => {
        console.log(chalk.gray(`  ${sender} (${count} emails)`));
      });
  }

  // Rescue legitimate emails
  async rescueLegitimateEmails(emails) {
    const spinner = ora('Moving legitimate emails back to inbox...').start();
    
    try {
      const inboxLabelId = 'INBOX';
      const likelySpamLabelId = await this.getLabelId('Likely Spam');
      
      // Process in batches
      const batchSize = 50;
      for (let i = 0; i < emails.length; i += batchSize) {
        const batch = emails.slice(i, i + batchSize);
        const ids = batch.map(e => e.id);
        
        await this.gmail.users.messages.batchModify({
          userId: 'me',
          requestBody: {
            ids: ids,
            addLabelIds: [inboxLabelId],
            removeLabelIds: [likelySpamLabelId]
          }
        });
        
        this.stats.rescued += ids.length;
        spinner.text = `Rescued ${Math.min(i + batchSize, emails.length)} of ${emails.length} emails`;
      }

      spinner.succeed(`✅ Rescued ${this.stats.rescued} legitimate emails back to inbox`);
    } catch (error) {
      spinner.fail('Failed to rescue emails');
      throw error;
    }
  }

  // Save analysis to file
  async saveAnalysis(legitimate, suspicious) {
    const resultsDir = path.join(__dirname, '../analysis-results');
    await fs.mkdir(resultsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `spam-analysis-${timestamp}.json`;

    const data = {
      timestamp: new Date().toISOString(),
      stats: this.stats,
      legitimate: legitimate.map(e => ({
        from: e.fromEmail,
        subject: e.subject,
        date: e.date
      })),
      legitimateCount: legitimate.length,
      suspiciousCount: suspicious.length
    };

    await fs.writeFile(
      path.join(resultsDir, filename),
      JSON.stringify(data, null, 2)
    );

    console.log(chalk.green(`\n💾 Analysis saved to: analysis-results/${filename}`));
  }
}

async function main() {
  console.log(chalk.bold.cyan('\n🔍 Likely Spam Analyzer & Rescue Tool\n'));
  console.log(chalk.gray('This tool analyzes your Likely Spam folder to find false positives.\n'));

  try {
    console.log(chalk.cyan('🔐 Authenticating with Gmail...'));
    const auth = await authorize();
    console.log(chalk.green('✅ Authentication successful!\n'));

    const analyzer = new LikelySpamAnalyzer(auth);
    
    // Analyze spam folder - increased to 5000 emails
    const { legitimate, suspicious, senderStats } = await analyzer.analyze(5000);
    
    // Display results
    analyzer.displayResults(legitimate, suspicious, senderStats);
    
    // Save analysis
    await analyzer.saveAnalysis(legitimate, suspicious);
    
    // Ask if user wants to rescue legitimate emails
    if (legitimate.length > 0) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      const rescue = await rl.question('\n' + 
        chalk.bold.yellow(`Move ${legitimate.length} legitimate emails back to inbox? (y/n): `));
      
      if (rescue.toLowerCase() === 'y') {
        await analyzer.rescueLegitimateEmails(legitimate);
        console.log(chalk.green('\n✅ Legitimate emails have been rescued!'));
      } else {
        console.log(chalk.yellow('\nNo emails were moved. You can review the analysis and run again.'));
      }
      
      rl.close();
    } else {
      console.log(chalk.green('\n✅ Great! No false positives found in your Likely Spam folder.'));
    }
    
  } catch (error) {
    console.error(chalk.red('\n❌ Error:'), error.message);
    if (error.message.includes('invalid_grant')) {
      console.log(chalk.yellow('\nTry deleting token.json and running again.'));
    }
  }
}

main();