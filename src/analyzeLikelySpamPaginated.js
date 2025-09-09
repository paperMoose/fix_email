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

class PaginatedSpamAnalyzer {
  constructor(auth) {
    this.gmail = google.gmail({ version: 'v1', auth });
    this.vipEmails = process.env.VIP_EMAILS ? process.env.VIP_EMAILS.split(',').map(e => e.trim().toLowerCase()) : [];
    this.protectedSenders = process.env.PROTECTED_SENDERS ? process.env.PROTECTED_SENDERS.split(',').map(e => e.trim().toLowerCase()) : [];
    this.checkpointFile = path.join(__dirname, '../.spam-checkpoint.json');
    this.batchSize = 100; // Analyze 100 emails at a time
    this.totalStats = {
      analyzed: 0,
      legitimate: 0,
      suspicious: 0,
      rescued: 0
    };
  }

  // Load checkpoint
  async loadCheckpoint() {
    try {
      const data = await fs.readFile(this.checkpointFile, 'utf8');
      return JSON.parse(data);
    } catch {
      return {
        pageToken: null,
        totalAnalyzed: 0,
        totalRescued: 0,
        lastRun: null
      };
    }
  }

  // Save checkpoint
  async saveCheckpoint(pageToken, totalAnalyzed, totalRescued) {
    const checkpoint = {
      pageToken,
      totalAnalyzed,
      totalRescued,
      lastRun: new Date().toISOString()
    };
    await fs.writeFile(this.checkpointFile, JSON.stringify(checkpoint, null, 2));
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
      return { legitimate: true, reason: 'VIP sender' };
    }

    // Check if protected sender
    if (this.protectedSenders.includes(fromEmail)) {
      return { legitimate: true, reason: 'Protected sender' };
    }

    // Google services that should be protected
    if (fromEmail.includes('@google.com') && 
        (fromEmail.includes('drive-shares') || 
         fromEmail.includes('docs-') || 
         fromEmail.includes('calendar-notification'))) {
      return { legitimate: true, reason: 'Google collaboration notification' };
    }

    // Check for legitimate services
    const legitimatePatterns = [
      // Banking/Financial
      { pattern: /@chase\.com$/, reason: 'Banking service' },
      { pattern: /@capitalone\.com$/, reason: 'Banking service' },
      { pattern: /@mercury\.com$/, reason: 'Banking service' },
      { pattern: /@stripe\.com$/, reason: 'Payment processor' },
      { pattern: /@paypal\.com$/, reason: 'Payment service' },
      { pattern: /@venmo\.com$/, reason: 'Payment service' },
      { pattern: /@coinbase\.com$/, reason: 'Crypto service' },
      { pattern: /@robinhood\.com$/, reason: 'Investment service' },
      
      // Important services
      { pattern: /@apple\.com$/, reason: 'Apple service' },
      { pattern: /drive-shares.*@google\.com$/, reason: 'Google Drive sharing' },
      { pattern: /docs-.*@google\.com$/, reason: 'Google Docs' },
      { pattern: /@anthropic\.com$/, reason: 'AI service' },
      { pattern: /@openai\.com$/, reason: 'AI service' },
      { pattern: /@github\.com$/, reason: 'Development platform' },
      
      // Healthcare
      { pattern: /@sutterhealth\.org$/, reason: 'Healthcare provider' },
      { pattern: /@myhealth/, reason: 'Healthcare service' },
      { pattern: /@kaiserpermanente\.org$/, reason: 'Healthcare provider' },
      { pattern: /@anthem\.com$/, reason: 'Health insurance' },
      
      // Travel
      { pattern: /@united\.com$/, reason: 'Airline' },
      { pattern: /@delta\.com$/, reason: 'Airline' },
      { pattern: /@southwest\.com$/, reason: 'Airline' },
      { pattern: /@airbnb\.com$/, reason: 'Travel booking' },
      
      // Work/HR
      { pattern: /@rippling\.com$/, reason: 'HR platform' },
      { pattern: /@gusto\.com$/, reason: 'HR platform' },
      
      // Delivery
      { pattern: /@uber\.com$/, reason: 'Delivery service' },
      { pattern: /@doordash\.com$/, reason: 'Delivery service' },
      { pattern: /@grubhub\.com$/, reason: 'Delivery service' }
    ];

    for (const { pattern, reason } of legitimatePatterns) {
      if (pattern.test(fromEmail)) {
        // Extra check for transactional emails
        const transactionKeywords = ['payment', 'receipt', 'order', 'confirmation', 'invoice', 
                                     'payroll', 'benefits', 'appointment', 'reservation', 'statement',
                                     'bill', 'charged', 'refund', 'shipped', 'delivered', 'shared', 'added'];
        if (transactionKeywords.some(keyword => subject.includes(keyword))) {
          return { legitimate: true, reason: `${reason} - transaction/notification` };
        }
        
        // Service-specific checks
        if (fromEmail.includes('paypal.com') && 
            (subject.includes('payment') || subject.includes('received') || subject.includes('sent'))) {
          return { legitimate: true, reason: 'PayPal transaction' };
        }
        
        if (fromEmail.includes('rippling.com') && 
            (subject.includes('payroll') || subject.includes('benefits') || subject.includes('tax'))) {
          return { legitimate: true, reason: 'HR critical email' };
        }

        // For other legitimate services, still flag as potentially legitimate
        if (reason.includes('service') || reason.includes('platform')) {
          return { legitimate: true, reason };
        }
      }
    }

    // Check for personal emails
    if (!fromEmail.includes('noreply') && 
        !fromEmail.includes('no-reply') && 
        !fromEmail.includes('notification') &&
        !fromEmail.includes('newsletter') &&
        !fromEmail.includes('marketing') &&
        email.from.includes('<') && 
        !email.from.toLowerCase().includes('team') &&
        !email.from.toLowerCase().includes('support')) {
      
      const serviceDomains = ['mailchimp.com', 'sendgrid.net', 'mailgun.org', 'amazonses.com', 
                             'beehiiv.com', 'substack.com', 'constantcontact.com'];
      if (!serviceDomains.some(domain => fromEmail.includes(domain))) {
        return { legitimate: true, reason: 'Likely personal email' };
      }
    }

    return { legitimate: false, reason: 'Spam/Marketing' };
  }

  // Fetch a batch of emails
  async fetchBatch(pageToken = null) {
    const spinner = ora('Fetching batch from Likely Spam folder...').start();
    
    try {
      const likelySpamLabelId = await this.getLabelId('Likely Spam');
      if (!likelySpamLabelId) {
        spinner.fail('Likely Spam label not found');
        return { messages: [], nextPageToken: null };
      }

      const response = await this.gmail.users.messages.list({
        userId: 'me',
        labelIds: [likelySpamLabelId],
        maxResults: this.batchSize,
        pageToken: pageToken
      });

      const messages = response.data.messages || [];
      spinner.succeed(`Fetched ${messages.length} emails`);
      
      return {
        messages,
        nextPageToken: response.data.nextPageToken
      };
    } catch (error) {
      spinner.fail('Failed to fetch emails');
      throw error;
    }
  }

  // Analyze a batch of emails
  async analyzeBatch(messages) {
    const spinner = ora('Analyzing batch...').start();
    const legitimate = [];
    const suspicious = [];
    
    for (let i = 0; i < messages.length; i++) {
      try {
        const detail = await this.gmail.users.messages.get({
          userId: 'me',
          id: messages[i].id,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date', 'Reply-To']
        });

        const headers = detail.data.payload.headers.reduce((acc, h) => {
          acc[h.name.toLowerCase()] = h.value;
          return acc;
        }, {});

        const from = headers.from || '';
        const subject = headers.subject || '';
        const date = headers.date || '';
        const replyTo = headers['reply-to'] || '';
        const fromEmail = this.extractEmail(from).toLowerCase();

        const email = {
          id: messages[i].id,
          from,
          fromEmail,
          subject,
          date,
          replyTo,
          labels: detail.data.labelIds || []
        };

        const { legitimate: isLegit, reason } = this.isLegitimate(email);
        email.reason = reason;
        
        if (isLegit) {
          legitimate.push(email);
        } else {
          suspicious.push(email);
        }
        
        spinner.text = `Analyzed ${i + 1} of ${messages.length} emails`;
      } catch (err) {
        // Skip if can't get details
      }
    }
    
    spinner.succeed(`Analysis complete: ${legitimate.length} legitimate, ${suspicious.length} spam`);
    return { legitimate, suspicious };
  }

  // Display batch results
  displayBatchResults(legitimate, suspicious, batchNum, checkpoint) {
    console.log('\n' + chalk.bold.cyan(`📊 Batch ${batchNum} Analysis Results`));
    console.log(chalk.gray('='.repeat(60)));
    
    console.log(chalk.bold(`Batch size: ${legitimate.length + suspicious.length} emails`));
    console.log(chalk.green(`✅ Potentially legitimate: ${legitimate.length}`));
    console.log(chalk.red(`❌ Confirmed spam: ${suspicious.length}`));
    
    if (checkpoint.totalAnalyzed > 0) {
      console.log(chalk.gray(`\nTotal analyzed so far: ${checkpoint.totalAnalyzed + legitimate.length + suspicious.length}`));
      console.log(chalk.gray(`Total rescued so far: ${checkpoint.totalRescued}`));
    }
    
    if (legitimate.length > 0) {
      console.log('\n' + chalk.bold.yellow('Legitimate emails in this batch:'));
      
      // Group by reason
      const byReason = {};
      legitimate.forEach(email => {
        const reason = email.reason || 'Unknown';
        if (!byReason[reason]) {
          byReason[reason] = [];
        }
        byReason[reason].push(email);
      });
      
      Object.entries(byReason).forEach(([reason, emails]) => {
        console.log(chalk.cyan(`\n${reason} (${emails.length}):`));
        emails.slice(0, 5).forEach(email => {
          const subject = email.subject.length > 50 ? 
            email.subject.substring(0, 50) + '...' : email.subject;
          console.log(chalk.gray(`  • ${email.fromEmail}: "${subject}"`));
        });
        if (emails.length > 5) {
          console.log(chalk.gray(`  ... and ${emails.length - 5} more`));
        }
      });
    }
    
    if (suspicious.length > 0) {
      console.log('\n' + chalk.bold.red('Sample spam emails (correctly filtered):'));
      const spamSample = suspicious.slice(0, 5);
      spamSample.forEach(email => {
        console.log(chalk.gray(`  • ${email.fromEmail}`));
      });
      if (suspicious.length > 5) {
        console.log(chalk.gray(`  ... and ${suspicious.length - 5} more spam emails`));
      }
    }
  }

  // Rescue emails
  async rescueEmails(emails) {
    const spinner = ora('Moving legitimate emails back to inbox...').start();
    
    try {
      const inboxLabelId = 'INBOX';
      const likelySpamLabelId = await this.getLabelId('Likely Spam');
      
      const ids = emails.map(e => e.id);
      
      await this.gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: {
          ids: ids,
          addLabelIds: [inboxLabelId],
          removeLabelIds: [likelySpamLabelId]
        }
      });
      
      spinner.succeed(`✅ Rescued ${emails.length} legitimate emails`);
      return emails.length;
    } catch (error) {
      spinner.fail('Failed to rescue emails');
      throw error;
    }
  }
}

async function main() {
  console.log(chalk.bold.cyan('\n🔍 Paginated Spam Analyzer & Rescue Tool\n'));
  console.log(chalk.gray('Analyze your Likely Spam folder in batches.\n'));

  try {
    console.log(chalk.cyan('🔐 Authenticating with Gmail...'));
    const auth = await authorize();
    console.log(chalk.green('✅ Authentication successful!\n'));

    const analyzer = new PaginatedSpamAnalyzer(auth);
    
    // Load checkpoint
    const checkpoint = await analyzer.loadCheckpoint();
    if (checkpoint.lastRun) {
      console.log(chalk.yellow(`📍 Resuming from last session (${checkpoint.lastRun})`));
      console.log(chalk.gray(`  Previously analyzed: ${checkpoint.totalAnalyzed} emails`));
      console.log(chalk.gray(`  Previously rescued: ${checkpoint.totalRescued} emails\n`));
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    let pageToken = checkpoint.pageToken;
    let batchNum = Math.floor(checkpoint.totalAnalyzed / analyzer.batchSize) + 1;
    let totalAnalyzed = checkpoint.totalAnalyzed;
    let totalRescued = checkpoint.totalRescued;
    let continueAnalyzing = true;

    while (continueAnalyzing) {
      // Fetch batch
      const { messages, nextPageToken } = await analyzer.fetchBatch(pageToken);
      
      if (messages.length === 0) {
        console.log(chalk.green('\n✅ No more emails to analyze!'));
        break;
      }

      // Analyze batch
      const { legitimate, suspicious } = await analyzer.analyzeBatch(messages);
      
      // Display results
      analyzer.displayBatchResults(legitimate, suspicious, batchNum, 
        { totalAnalyzed, totalRescued });
      
      // Update totals
      totalAnalyzed += messages.length;
      
      // Ask what to do
      if (legitimate.length > 0) {
        const action = await rl.question('\n' + chalk.bold.yellow(
          `What would you like to do?\n` +
          `  [r] Rescue ${legitimate.length} legitimate emails\n` +
          `  [s] Skip this batch\n` +
          `  [v] View full list\n` +
          `  [q] Quit and save progress\n` +
          `Choice: `
        ));
        
        if (action.toLowerCase() === 'r') {
          const rescued = await analyzer.rescueEmails(legitimate);
          totalRescued += rescued;
        } else if (action.toLowerCase() === 'v') {
          console.log('\n' + chalk.bold.cyan('Full list of legitimate emails:'));
          legitimate.forEach((email, i) => {
            console.log(chalk.yellow(`\n${i + 1}. ${email.fromEmail}`));
            console.log(chalk.gray(`   Subject: ${email.subject}`));
            console.log(chalk.gray(`   Reason: ${email.reason}`));
            if (email.replyTo && email.replyTo !== email.from) {
              console.log(chalk.gray(`   Reply-To: ${email.replyTo}`));
            }
          });
          
          const afterView = await rl.question('\n' + chalk.yellow('Rescue these emails? (y/n): '));
          if (afterView.toLowerCase() === 'y') {
            const rescued = await analyzer.rescueEmails(legitimate);
            totalRescued += rescued;
          }
        } else if (action.toLowerCase() === 'q') {
          continueAnalyzing = false;
          break;
        }
      }
      
      // Ask to continue
      if (nextPageToken) {
        const cont = await rl.question('\n' + chalk.cyan('Continue to next batch? (y/n): '));
        if (cont.toLowerCase() !== 'y') {
          continueAnalyzing = false;
        }
      } else {
        console.log(chalk.green('\n✅ Reached the end of Likely Spam folder!'));
        continueAnalyzing = false;
      }
      
      // Save checkpoint
      await analyzer.saveCheckpoint(nextPageToken, totalAnalyzed, totalRescued);
      
      pageToken = nextPageToken;
      batchNum++;
    }
    
    rl.close();
    
    // Final summary
    console.log('\n' + chalk.bold.green('📊 Final Summary'));
    console.log(chalk.gray('='.repeat(60)));
    console.log(chalk.bold(`Total emails analyzed: ${totalAnalyzed}`));
    console.log(chalk.green(`Total emails rescued: ${totalRescued}`));
    
    // Clear checkpoint if finished
    if (!pageToken) {
      await fs.unlink(analyzer.checkpointFile).catch(() => {});
      console.log(chalk.gray('\n✨ Analysis complete - checkpoint cleared'));
    } else {
      console.log(chalk.yellow('\n📍 Progress saved - run again to continue'));
    }
    
  } catch (error) {
    console.error(chalk.red('\n❌ Error:'), error.message);
    if (error.message.includes('invalid_grant')) {
      console.log(chalk.yellow('\nTry deleting token.json and running again.'));
    }
  }
}

main();