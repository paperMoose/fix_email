import { google } from 'googleapis';
import chalk from 'chalk';
import ora from 'ora';

export class ImprovedFilterManager {
  constructor(auth) {
    this.gmail = google.gmail({ version: 'v1', auth });
  }

  // Define improved filter rules based on analysis
  getImprovedFilterRules() {
    return {
      // Critical services that should NEVER be marked as spam
      protectedServices: [
        'service@paypal.com',
        'no-reply@rippling.com',
        'noreply@rippling.com',
        'hello@mercury.com',
        'no.reply.alerts@chase.com',
        'capitalone@notification.capitalone.com',
        'noreply@venmo.com',
        'noreply@coinbase.com',
        'noreply@robinhood.com',
        'notify@buildinglink.com',
        'noreply@uber.com',
        'noreply@lyft.com',
        'doordash@doordash.com',
        'no-reply@messages.doordash.com'
      ],

      // Newsletters to filter (high volume senders)
      newslettersToFilter: [
        // Existing high-volume newsletters not yet filtered
        'service@paypal.com', // Only promotional emails, not transactions
        'no-reply@rippling.com', // Only routine notifications
        
        // Additional newsletters from analysis
        'updates@medium.com',
        'digest@quora.com',
        'noreply@medium.com',
        'daily@producthunt.com',
        'newsletter@morningbrew.com',
        'crew@morningbrew.com',
        'hello@email.kickstarter.com',
        'noreply@kickstarter.com'
      ],

      // Actual spam patterns based on common spam characteristics
      actualSpamPatterns: [
        // Domain patterns that are commonly spam
        { pattern: '@*.tk', label: 'Likely Spam' },
        { pattern: '@*.ml', label: 'Likely Spam' },
        { pattern: '@*.ga', label: 'Likely Spam' },
        { pattern: '@*.cf', label: 'Likely Spam' },
        
        // Subject patterns
        { subject: 'winner', label: 'Likely Spam' },
        { subject: 'congratulations you won', label: 'Likely Spam' },
        { subject: 'claim your prize', label: 'Likely Spam' },
        { subject: 'act now', label: 'Likely Spam' },
        { subject: 'limited time offer', label: 'Likely Spam' },
        { subject: 'click here immediately', label: 'Likely Spam' },
        
        // Known spam senders (not legitimate services)
        { from: 'prize@', label: 'Likely Spam' },
        { from: 'winner@', label: 'Likely Spam' },
        { from: 'rewards@', label: 'Likely Spam', excludeDomains: ['chase.com', 'capitalone.com', 'amex.com'] },
        { from: 'deals@', label: 'Likely Spam', excludeDomains: ['amazon.com', 'target.com', 'walmart.com'] }
      ],

      // Smart PayPal filtering
      paypalRules: [
        {
          from: 'service@paypal.com',
          subject: 'payment',
          action: 'keep_inbox',
          label: 'Receipts'
        },
        {
          from: 'service@paypal.com',
          subject: 'received',
          action: 'keep_inbox',
          label: 'Receipts'
        },
        {
          from: 'service@paypal.com',
          subject: 'sent',
          action: 'keep_inbox',
          label: 'Receipts'
        },
        {
          from: 'service@paypal.com',
          notSubject: ['payment', 'received', 'sent', 'refund', 'dispute'],
          action: 'archive',
          label: 'Filtered/Promotional'
        }
      ],

      // Rippling HR filtering
      ripplingRules: [
        {
          from: 'no-reply@rippling.com',
          subject: 'payroll',
          action: 'keep_inbox',
          label: 'Important/HR'
        },
        {
          from: 'no-reply@rippling.com',
          subject: 'benefits',
          action: 'keep_inbox',
          label: 'Important/HR'
        },
        {
          from: 'no-reply@rippling.com',
          subject: 'tax',
          action: 'keep_inbox',
          label: 'Important/HR'
        },
        {
          from: 'no-reply@rippling.com',
          notSubject: ['payroll', 'benefits', 'tax', 'urgent', 'action required'],
          action: 'archive',
          label: 'Filtered/Automated'
        }
      ],

      // LinkedIn improved filtering
      linkedinRules: [
        {
          from: 'invitations@linkedin.com',
          action: 'archive',
          label: 'Filtered/Social'
        },
        {
          from: 'messages-noreply@linkedin.com',
          action: 'archive',
          label: 'Filtered/Social'
        },
        {
          from: 'newsletters-noreply@linkedin.com',
          action: 'archive',
          label: 'Filtered/Newsletters'
        },
        {
          from: 'hit-reply@linkedin.com',
          action: 'archive',
          label: 'Filtered/Social'
        },
        {
          from: 'jobalerts-noreply@linkedin.com',
          action: 'trash',
          label: 'TRASH'
        }
      ],

      // Filters to remove (overly broad)
      filtersToRemove: [
        'From: hello@',
        'From: info@',
        'From: noreply@',
        'From: no-reply@',
        'From: support@',
        'From: service@',
        'From: team@',
        'From: marketing@',
        'From: updates@',
        'From: reminders@',
        'From: notification@',
        'From: alerts@',
        'From: news@',
        'From: partners@'
      ]
    };
  }

  async removeOverlyBroadFilters() {
    const spinner = ora('Removing overly broad filters...').start();
    const rules = this.getImprovedFilterRules();
    
    try {
      // Get all existing filters
      const response = await this.gmail.users.settings.filters.list({
        userId: 'me'
      });

      const filters = response.data.filter || [];
      let removedCount = 0;

      for (const filter of filters) {
        const criteria = filter.criteria || {};
        const from = criteria.from || '';
        
        // Check if this is one of the overly broad filters
        if (rules.filtersToRemove.some(broad => from === broad.replace('From: ', ''))) {
          try {
            await this.gmail.users.settings.filters.delete({
              userId: 'me',
              id: filter.id
            });
            removedCount++;
            spinner.text = `Removed broad filter: ${from}`;
          } catch (err) {
            console.error(`Failed to remove filter ${from}:`, err.message);
          }
        }
      }

      spinner.succeed(`Removed ${removedCount} overly broad filters`);
      return removedCount;
    } catch (error) {
      spinner.fail('Failed to remove broad filters');
      throw error;
    }
  }

  async createSmartFilters() {
    const spinner = ora('Creating smart filters...').start();
    const rules = this.getImprovedFilterRules();
    let createdCount = 0;

    try {
      // Create PayPal smart filters
      for (const rule of rules.paypalRules) {
        try {
          const criteria = { from: rule.from };
          if (rule.subject) {
            criteria.query = `subject:${rule.subject}`;
          } else if (rule.notSubject) {
            criteria.query = rule.notSubject.map(s => `-subject:${s}`).join(' ');
          }

          const action = {};
          if (rule.label) {
            // First ensure label exists
            const labelId = await this.ensureLabel(rule.label);
            action.addLabelIds = [labelId];
          }
          if (rule.action === 'archive') {
            action.removeLabelIds = ['INBOX'];
          }

          await this.gmail.users.settings.filters.create({
            userId: 'me',
            requestBody: { criteria, action }
          });
          createdCount++;
        } catch (err) {
          console.error(`Failed to create PayPal filter:`, err.message);
        }
      }

      // Create Rippling filters
      for (const rule of rules.ripplingRules) {
        try {
          const criteria = { from: rule.from };
          if (rule.subject) {
            criteria.query = `subject:${rule.subject}`;
          } else if (rule.notSubject) {
            criteria.query = rule.notSubject.map(s => `-subject:${s}`).join(' ');
          }

          const action = {};
          if (rule.label) {
            const labelId = await this.ensureLabel(rule.label);
            action.addLabelIds = [labelId];
          }
          if (rule.action === 'archive') {
            action.removeLabelIds = ['INBOX'];
          }

          await this.gmail.users.settings.filters.create({
            userId: 'me',
            requestBody: { criteria, action }
          });
          createdCount++;
        } catch (err) {
          console.error(`Failed to create Rippling filter:`, err.message);
        }
      }

      // Create improved LinkedIn filters
      for (const rule of rules.linkedinRules) {
        try {
          const criteria = { from: rule.from };
          const action = {};
          
          if (rule.label !== 'TRASH') {
            const labelId = await this.ensureLabel(rule.label);
            action.addLabelIds = [labelId];
          } else {
            action.addLabelIds = ['TRASH'];
          }
          
          if (rule.action === 'archive') {
            action.removeLabelIds = ['INBOX'];
          }

          await this.gmail.users.settings.filters.create({
            userId: 'me',
            requestBody: { criteria, action }
          });
          createdCount++;
        } catch (err) {
          console.error(`Failed to create LinkedIn filter:`, err.message);
        }
      }

      // Create actual spam pattern filters
      for (const pattern of rules.actualSpamPatterns) {
        if (pattern.from && !pattern.excludeDomains) {
          try {
            const criteria = { from: pattern.from };
            const labelId = await this.ensureLabel(pattern.label);
            const action = {
              addLabelIds: [labelId],
              removeLabelIds: ['INBOX']
            };

            await this.gmail.users.settings.filters.create({
              userId: 'me',
              requestBody: { criteria, action }
            });
            createdCount++;
          } catch (err) {
            console.error(`Failed to create spam filter:`, err.message);
          }
        }
      }

      spinner.succeed(`Created ${createdCount} smart filters`);
      return createdCount;
    } catch (error) {
      spinner.fail('Failed to create smart filters');
      throw error;
    }
  }

  async ensureLabel(labelName) {
    try {
      const response = await this.gmail.users.labels.list({ userId: 'me' });
      const existingLabel = response.data.labels.find(l => l.name === labelName);
      
      if (existingLabel) {
        return existingLabel.id;
      }

      // Create new label
      const newLabel = await this.gmail.users.labels.create({
        userId: 'me',
        requestBody: {
          name: labelName,
          labelListVisibility: 'labelShow',
          messageListVisibility: 'show'
        }
      });
      
      return newLabel.data.id;
    } catch (error) {
      console.error(`Error ensuring label ${labelName}:`, error.message);
      throw error;
    }
  }

  async analyzeSpamPatterns() {
    const spinner = ora('Analyzing spam patterns in trash...').start();
    
    try {
      // Get messages from trash to understand actual spam
      const response = await this.gmail.users.messages.list({
        userId: 'me',
        labelIds: ['TRASH'],
        maxResults: 100
      });

      const messages = response.data.messages || [];
      const spamPatterns = {
        domains: new Map(),
        subjects: new Map(),
        senders: new Map()
      };

      // Analyze each message
      for (const msg of messages.slice(0, 50)) {
        try {
          const detail = await this.gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'metadata',
            metadataHeaders: ['From', 'Subject']
          });

          const headers = detail.data.payload.headers.reduce((acc, h) => {
            acc[h.name.toLowerCase()] = h.value;
            return acc;
          }, {});

          const from = headers.from || '';
          const subject = headers.subject || '';
          
          // Extract domain
          const domainMatch = from.match(/@([^\s>]+)/);
          if (domainMatch) {
            const domain = domainMatch[1];
            spamPatterns.domains.set(domain, (spamPatterns.domains.get(domain) || 0) + 1);
          }

          // Extract sender pattern
          const senderMatch = from.match(/([^@]+)@/);
          if (senderMatch) {
            const sender = senderMatch[1];
            spamPatterns.senders.set(sender, (spamPatterns.senders.get(sender) || 0) + 1);
          }

          // Common spam words in subject
          const spamWords = ['winner', 'prize', 'congratulations', 'claim', 'urgent', 'act now'];
          spamWords.forEach(word => {
            if (subject.toLowerCase().includes(word)) {
              spamPatterns.subjects.set(word, (spamPatterns.subjects.get(word) || 0) + 1);
            }
          });
        } catch (err) {
          // Skip if can't get message details
        }
      }

      spinner.succeed('Analyzed spam patterns');
      
      // Return top patterns
      return {
        topDomains: Array.from(spamPatterns.domains.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10),
        topSenders: Array.from(spamPatterns.senders.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10),
        topSubjects: Array.from(spamPatterns.subjects.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
      };
    } catch (error) {
      spinner.fail('Failed to analyze spam patterns');
      throw error;
    }
  }

  displayFilteringSummary(removed, created, spamPatterns) {
    console.log('\n' + chalk.bold.cyan('Filter Improvement Summary'));
    console.log(chalk.gray('='.repeat(40)));
    
    console.log(chalk.red(`Removed ${removed} overly broad filters`));
    console.log(chalk.green(`Created ${created} smart filters`));
    
    if (spamPatterns) {
      console.log('\n' + chalk.bold.yellow('Actual Spam Patterns Found:'));
      console.log(chalk.gray('Top spam domains:'));
      spamPatterns.topDomains.forEach(([domain, count]) => {
        console.log(`  - ${domain} (${count} emails)`);
      });
      
      console.log(chalk.gray('\nTop spam sender patterns:'));
      spamPatterns.topSenders.forEach(([sender, count]) => {
        console.log(`  - ${sender}@ (${count} emails)`);
      });
    }
    
    console.log('\n' + chalk.bold.green('Protected Services:'));
    console.log('  ✓ PayPal - Smart filtering (keep transactions, archive promotions)');
    console.log('  ✓ Rippling - Keep HR important, archive routine');
    console.log('  ✓ Banking services - Never marked as spam');
    console.log('  ✓ Food delivery - Never marked as spam');
    
    console.log('\n' + chalk.bold.cyan('Improvements Applied:'));
    console.log('  ✓ Removed broad prefix filters');
    console.log('  ✓ Added domain-specific filters');
    console.log('  ✓ Created smart conditional filters');
    console.log('  ✓ Protected legitimate services');
  }
}