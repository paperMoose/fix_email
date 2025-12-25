import { google } from 'googleapis';
import ora from 'ora';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { withRetry, extractEmail, isProtectedSender, isFromProtectedDomain, RateLimiter } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class EmailAnalyzer {
  constructor(auth, vipEmails = [], protectedSenders = [], protectedKeywords = []) {
    this.gmail = google.gmail({ version: 'v1', auth });
    this.vipEmails = vipEmails.map(email => email.toLowerCase().trim());
    this.protectedSenders = protectedSenders.map(email => email.toLowerCase().trim());
    this.protectedKeywords = protectedKeywords.map(keyword => keyword.toLowerCase().trim());
    this.rateLimiter = new RateLimiter(10); // 10 requests per second
    this.emailStats = {
      total: 0,
      fromVIP: [],
      protected: [],
      newsletters: [],
      promotional: [],
      social: [],
      forums: [],
      automated: [],
      receipts: [],
      confirmations: [],
      personal: [],
      unknown: []
    };
  }

  async fetchEmails(maxResults = 500) {
    const spinner = ora('Fetching emails...').start();
    let allMessages = [];
    let pageToken = null;

    try {
      do {
        const response = await this.gmail.users.messages.list({
          userId: 'me',
          maxResults: Math.min(maxResults - allMessages.length, 100),
          pageToken: pageToken
        });

        if (response.data.messages) {
          allMessages = allMessages.concat(response.data.messages);
        }

        pageToken = response.data.nextPageToken;
      } while (pageToken && allMessages.length < maxResults);

      spinner.succeed(`Fetched ${allMessages.length} email IDs`);
      return allMessages;
    } catch (error) {
      spinner.fail('Failed to fetch emails');
      throw error;
    }
  }

  async fetchEmailsSince(date, maxResults = 500) {
    const spinner = ora(`Fetching emails since ${date}...`).start();
    let allMessages = [];
    let pageToken = null;

    try {
      // Gmail query to get emails after a specific date
      const query = `after:${date}`;
      
      do {
        const response = await this.gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults: Math.min(maxResults - allMessages.length, 100),
          pageToken: pageToken
        });

        if (response.data.messages) {
          allMessages = allMessages.concat(response.data.messages);
        }

        pageToken = response.data.nextPageToken;
      } while (pageToken && allMessages.length < maxResults);

      spinner.succeed(`Fetched ${allMessages.length} email IDs since ${date}`);
      return allMessages;
    } catch (error) {
      spinner.fail('Failed to fetch emails');
      throw error;
    }
  }

  async analyzeEmail(messageId) {
    try {
      await this.rateLimiter.wait();

      const response = await withRetry(async () => {
        return this.gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'List-Unsubscribe', 'List-ID']
        });
      });

      const message = response.data;
      const headers = message.payload.headers.reduce((acc, header) => {
        acc[header.name.toLowerCase()] = header.value;
        return acc;
      }, {});

      const from = headers.from || '';
      const subject = headers.subject || '';
      const fromEmail = extractEmail(from);
      const labels = message.labelIds || [];

      const analysis = {
        id: messageId,
        from: from,
        fromEmail: fromEmail,
        subject: subject,
        labels: labels,
        category: this.categorizeEmail(headers, labels, fromEmail, subject)
      };

      return analysis;
    } catch (error) {
      console.error(`Error analyzing message ${messageId}:`, error.message);
      return null;
    }
  }

  categorizeEmail(headers, labels, fromEmail, subject) {
    // Check if this is a VIP email
    if (this.vipEmails.includes(fromEmail)) {
      return 'vip';
    }

    // Check if this is a protected sender
    if (this.protectedSenders.includes(fromEmail)) {
      return 'protected';
    }

    // Check if subject contains protected keywords
    const subjectLower = subject.toLowerCase();
    if (this.protectedKeywords.some(keyword => subjectLower.includes(keyword))) {
      return 'protected';
    }

    if (headers['list-unsubscribe'] || headers['list-id']) {
      return 'newsletter';
    }

    if (labels.includes('CATEGORY_PROMOTIONS')) {
      return 'promotional';
    }

    if (labels.includes('CATEGORY_SOCIAL')) {
      return 'social';
    }

    if (labels.includes('CATEGORY_FORUMS')) {
      return 'forums';
    }

    const automatedPatterns = [
      /noreply/i,
      /no-reply/i,
      /donotreply/i,
      /automated/i,
      /notification/i,
      /alert/i,
      /system/i
    ];

    if (automatedPatterns.some(pattern => pattern.test(fromEmail))) {
      return 'automated';
    }

    const newsletterSubjectPatterns = [
      /newsletter/i,
      /weekly digest/i,
      /daily digest/i,
      /update from/i,
      /news from/i
    ];

    if (newsletterSubjectPatterns.some(pattern => pattern.test(subject))) {
      return 'newsletter';
    }

    // Check for receipts
    const receiptPatterns = [
      /receipt/i,
      /payment/i,
      /invoice/i,
      /charged/i,
      /your purchase/i,
      /order.*shipped/i,
      /order.*delivered/i
    ];

    if (receiptPatterns.some(pattern => pattern.test(subject)) || 
        fromEmail.includes('paypal.com') || 
        fromEmail.includes('invoice') ||
        fromEmail.includes('amazon.com')) {
      return 'receipt';
    }

    // Check for confirmations
    const confirmationPatterns = [
      /confirmation/i,
      /confirmed/i,
      /appointment/i,
      /reservation/i,
      /scheduled/i,
      /registration/i
    ];

    if (confirmationPatterns.some(pattern => pattern.test(subject))) {
      return 'confirmation';
    }

    return 'unknown';
  }

  async analyzeAllEmails(messages) {
    const spinner = ora('Analyzing emails...').start();
    const batchSize = 10;
    
    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);
      const analyses = await Promise.all(
        batch.map(msg => this.analyzeEmail(msg.id))
      );

      analyses.forEach(analysis => {
        if (analysis) {
          this.emailStats.total++;
          switch (analysis.category) {
            case 'vip':
              this.emailStats.fromVIP.push(analysis);
              break;
            case 'protected':
              this.emailStats.protected.push(analysis);
              break;
            case 'newsletter':
              this.emailStats.newsletters.push(analysis);
              break;
            case 'promotional':
              this.emailStats.promotional.push(analysis);
              break;
            case 'social':
              this.emailStats.social.push(analysis);
              break;
            case 'forums':
              this.emailStats.forums.push(analysis);
              break;
            case 'automated':
              this.emailStats.automated.push(analysis);
              break;
            case 'receipt':
              this.emailStats.receipts.push(analysis);
              break;
            case 'confirmation':
              this.emailStats.confirmations.push(analysis);
              break;
            default:
              this.emailStats.unknown.push(analysis);
          }
        }
      });

      spinner.text = `Analyzed ${Math.min(i + batchSize, messages.length)} of ${messages.length} emails`;
    }

    spinner.succeed('Email analysis complete');
    return this.emailStats;
  }

  async saveAnalysisResults() {
    const resultsDir = path.join(__dirname, '../analysis-results');
    await fs.mkdir(resultsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `analysis-${timestamp}.json`;

    await fs.writeFile(
      path.join(resultsDir, filename),
      JSON.stringify(this.emailStats, null, 2)
    );

    console.log(chalk.green(`Analysis saved to: analysis-results/${filename}`));
  }

  displaySummary() {
    console.log('\n' + chalk.bold.cyan('Email Analysis Summary'));
    console.log(chalk.gray('='.repeat(40)));
    
    console.log(chalk.bold(`Total emails analyzed: ${this.emailStats.total}`));
    console.log();
    
    console.log(chalk.green(`VIP emails: ${this.emailStats.fromVIP.length}`));
    console.log(chalk.green.bold(`Protected emails: ${this.emailStats.protected.length}`) + chalk.gray(' (healthcare, travel, etc)'));
    console.log(chalk.yellow(`Newsletters: ${this.emailStats.newsletters.length}`));
    console.log(chalk.yellow(`Promotional: ${this.emailStats.promotional.length}`));
    console.log(chalk.blue(`Social: ${this.emailStats.social.length}`));
    console.log(chalk.blue(`Forums: ${this.emailStats.forums.length}`));
    console.log(chalk.red(`Automated: ${this.emailStats.automated.length}`));
    console.log(chalk.green(`Receipts: ${this.emailStats.receipts.length}`));
    console.log(chalk.cyan(`Confirmations: ${this.emailStats.confirmations.length}`));
    console.log(chalk.gray(`Unknown/Personal: ${this.emailStats.unknown.length}`));

    const senderFrequency = this.calculateSenderFrequency();
    console.log('\n' + chalk.bold.cyan('Top 10 Most Frequent Senders:'));
    console.log(chalk.gray('='.repeat(40)));
    
    senderFrequency.slice(0, 10).forEach((sender, index) => {
      console.log(`${index + 1}. ${sender.email} (${sender.count} emails)`);
    });
  }

  calculateSenderFrequency() {
    const senderMap = new Map();

    Object.values(this.emailStats).forEach(category => {
      if (Array.isArray(category)) {
        category.forEach(email => {
          if (email.fromEmail) {
            senderMap.set(email.fromEmail, (senderMap.get(email.fromEmail) || 0) + 1);
          }
        });
      }
    });

    return Array.from(senderMap.entries())
      .map(([email, count]) => ({ email, count }))
      .sort((a, b) => b.count - a.count);
  }
}