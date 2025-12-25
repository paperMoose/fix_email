import { google } from 'googleapis';
import ora from 'ora';
import chalk from 'chalk';
import { withRetry, isProtectedSender as checkProtectedSender, isFromProtectedDomain, RateLimiter, sleep } from './utils.js';

export class EmailFilter {
  constructor(auth, protectedSenders = []) {
    this.gmail = google.gmail({ version: 'v1', auth });
    this.protectedSenders = protectedSenders.map(email => email.toLowerCase().trim());
    this.rateLimiter = new RateLimiter(10);
    this.existingFilters = null; // Cache of existing filters
  }

  isProtectedSender(email) {
    // Use both exact match and domain-based matching
    return checkProtectedSender(email, this.protectedSenders) || isFromProtectedDomain(email);
  }

  async getExistingFilters() {
    if (this.existingFilters) return this.existingFilters;

    const response = await this.gmail.users.settings.filters.list({ userId: 'me' });
    this.existingFilters = response.data.filter || [];
    return this.existingFilters;
  }

  async filterExists(from) {
    const filters = await this.getExistingFilters();
    return filters.some(f => f.criteria?.from === from);
  }

  async createLabel(labelName, options = {}) {
    try {
      const response = await this.gmail.users.labels.create({
        userId: 'me',
        requestBody: {
          name: labelName,
          labelListVisibility: options.visibility || 'labelShow',
          messageListVisibility: options.messageVisibility || 'show'
        }
      });
      return response.data;
    } catch (error) {
      if (error.message.includes('Label name exists')) {
        const labels = await this.gmail.users.labels.list({ userId: 'me' });
        return labels.data.labels.find(label => label.name === labelName);
      }
      throw error;
    }
  }

  async setupFilteringLabels() {
    const spinner = ora('Setting up labels...').start();
    
    // Define labels without colors first (Gmail will assign defaults)
    const labels = [
      { name: 'Filtered/Newsletters' },
      { name: 'Filtered/Promotional' },
      { name: 'Filtered/Automated' },
      { name: 'Filtered/Social' },
      { name: 'Filtered/Forums' },
      { name: 'VIP' },
      { name: 'Protected' },
      { name: 'Receipts' },
      { name: 'Confirmations' },
      { name: 'Personal' }
    ];

    const createdLabels = {};

    for (const labelConfig of labels) {
      try {
        const label = await this.createLabel(labelConfig.name);
        createdLabels[labelConfig.name] = label;
      } catch (error) {
        console.error(`Error creating label ${labelConfig.name}:`, error.message);
      }
    }

    spinner.succeed('Labels setup complete');
    return createdLabels;
  }

  async applyLabel(messageIds, labelId) {
    if (!messageIds || messageIds.length === 0) return;

    const batchSize = 50;
    for (let i = 0; i < messageIds.length; i += batchSize) {
      const batch = messageIds.slice(i, i + batchSize);
      try {
        await this.gmail.users.messages.batchModify({
          userId: 'me',
          requestBody: {
            ids: batch,
            addLabelIds: [labelId]
          }
        });
      } catch (error) {
        console.error(`Error applying label to batch:`, error.message);
      }
    }
  }

  async archiveMessages(messageIds) {
    if (!messageIds || messageIds.length === 0) return;

    const batchSize = 50;
    for (let i = 0; i < messageIds.length; i += batchSize) {
      const batch = messageIds.slice(i, i + batchSize);
      try {
        await this.gmail.users.messages.batchModify({
          userId: 'me',
          requestBody: {
            ids: batch,
            removeLabelIds: ['INBOX']
          }
        });
      } catch (error) {
        console.error(`Error archiving batch:`, error.message);
      }
    }
  }

  async createFilters(analysisResults, labels) {
    const spinner = ora('Creating Gmail filters...').start();

    let createdCount = 0;
    const errors = [];

    // Create filters for frequent newsletters
    if (analysisResults.newsletters.length > 5) {
      const frequentNewsletters = this.getFrequentSenders(analysisResults.newsletters, 3);
      for (const sender of frequentNewsletters) {
        // Skip if filter already exists or sender is protected
        if (await this.filterExists(sender)) {
          continue;
        }
        if (this.isProtectedSender(sender)) {
          continue;
        }
        try {
          await this.rateLimiter.wait();
          await withRetry(async () => {
            return this.gmail.users.settings.filters.create({
              userId: 'me',
              requestBody: {
                criteria: {
                  from: sender,
                  excludeChats: true
                },
                action: {
                  addLabelIds: [labels['Filtered/Newsletters'].id],
                  removeLabelIds: ['INBOX']
                }
              }
            });
          });
          createdCount++;
        } catch (error) {
          errors.push(`Newsletter filter for ${sender}: ${error.message}`);
        }
      }
    }

    // Create filters for frequent promotional
    if (analysisResults.promotional.length > 5) {
      const frequentPromo = this.getFrequentSenders(analysisResults.promotional, 3);
      for (const sender of frequentPromo) {
        if (await this.filterExists(sender)) continue;
        if (this.isProtectedSender(sender)) continue;

        try {
          await this.rateLimiter.wait();
          await withRetry(async () => {
            return this.gmail.users.settings.filters.create({
              userId: 'me',
              requestBody: {
                criteria: {
                  from: sender,
                  excludeChats: true
                },
                action: {
                  addLabelIds: [labels['Filtered/Promotional'].id],
                  removeLabelIds: ['INBOX']
                }
              }
            });
          });
          createdCount++;
        } catch (error) {
          errors.push(`Promotional filter for ${sender}: ${error.message}`);
        }
      }
    }

    // Create filters for automated senders (but check if they're protected)
    if (analysisResults.automated.length > 5) {
      const frequentAutomated = this.getFrequentSenders(analysisResults.automated, 3);
      for (const sender of frequentAutomated) {
        if (await this.filterExists(sender)) continue;
        if (this.isProtectedSender(sender)) continue;

        try {
          await this.rateLimiter.wait();
          await withRetry(async () => {
            return this.gmail.users.settings.filters.create({
              userId: 'me',
              requestBody: {
                criteria: {
                  from: sender,
                  excludeChats: true
                },
                action: {
                  addLabelIds: [labels['Filtered/Automated'].id],
                  removeLabelIds: ['INBOX']
                }
              }
            });
          });
          createdCount++;
        } catch (error) {
          errors.push(`Automated filter for ${sender}: ${error.message}`);
        }
      }
    }

    if (errors.length > 0) {
      console.log(chalk.yellow('\nSome filters could not be created:'));
      errors.forEach(err => console.log(chalk.gray(`  - ${err}`)));
    }

    spinner.succeed(`Created ${createdCount} Gmail filters for future emails`);
    return createdCount;
  }

  getFrequentSenders(emails, minFrequency) {
    const senderCount = {};
    emails.forEach(email => {
      if (email.fromEmail) {
        senderCount[email.fromEmail] = (senderCount[email.fromEmail] || 0) + 1;
      }
    });

    return Object.entries(senderCount)
      .filter(([sender, count]) => count >= minFrequency)
      .map(([sender]) => sender);
  }

  async applyFiltersToExisting(analysisResults, labels) {
    const spinner = ora('Applying filters to existing emails...').start();

    const actions = [
      {
        emails: analysisResults.newsletters,
        labelId: labels['Filtered/Newsletters']?.id,
        archive: true
      },
      {
        emails: analysisResults.promotional,
        labelId: labels['Filtered/Promotional']?.id,
        archive: true
      },
      {
        emails: analysisResults.automated,
        labelId: labels['Filtered/Automated']?.id,
        archive: true
      },
      {
        emails: analysisResults.social,
        labelId: labels['Filtered/Social']?.id,
        archive: false
      },
      {
        emails: analysisResults.forums,
        labelId: labels['Filtered/Forums']?.id,
        archive: false
      },
      {
        emails: analysisResults.fromVIP,
        labelId: labels['VIP']?.id,
        archive: false
      },
      {
        emails: analysisResults.protected,
        labelId: labels['Protected']?.id,
        archive: false
      },
      {
        emails: analysisResults.receipts,
        labelId: labels['Receipts']?.id,
        archive: false
      },
      {
        emails: analysisResults.confirmations,
        labelId: labels['Confirmations']?.id,
        archive: false
      }
    ];

    for (const action of actions) {
      if (action.labelId && action.emails.length > 0) {
        const messageIds = action.emails.map(email => email.id);
        await this.applyLabel(messageIds, action.labelId);
        
        if (action.archive) {
          await this.archiveMessages(messageIds);
        }
        
        spinner.text = `Applied filters to ${action.emails.length} emails`;
      }
    }

    spinner.succeed('Filters applied to existing emails');
  }

  displayFilteringSummary(analysisResults) {
    console.log('\n' + chalk.bold.cyan('Filtering Summary'));
    console.log(chalk.gray('='.repeat(40)));
    
    const archived = 
      analysisResults.newsletters.length + 
      analysisResults.promotional.length + 
      analysisResults.automated.length;
    
    console.log(chalk.green(`Emails to be archived: ${archived}`));
    console.log(chalk.yellow(`Emails to be labeled but kept in inbox: ${
      analysisResults.social.length + 
      analysisResults.forums.length +
      analysisResults.receipts.length +
      analysisResults.confirmations.length
    }`));
    console.log(chalk.red.bold(`VIP emails preserved: ${analysisResults.fromVIP.length}`));
    console.log(chalk.green(`Receipts labeled: ${analysisResults.receipts.length}`));
    console.log(chalk.cyan(`Confirmations labeled: ${analysisResults.confirmations.length}`));
    
    const percentageFiltered = ((archived / analysisResults.total) * 100).toFixed(1);
    console.log('\n' + chalk.bold(`${percentageFiltered}% of emails will be auto-archived`));
  }
}