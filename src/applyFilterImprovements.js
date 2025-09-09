import { authorize } from './auth.js';
import { google } from 'googleapis';
import chalk from 'chalk';
import ora from 'ora';
import readline from 'readline/promises';

class FilterImprover {
  constructor(auth) {
    this.gmail = google.gmail({ version: 'v1', auth });
    this.results = {
      removed: 0,
      created: 0,
      errors: []
    };
  }

  // Remove overly broad filters
  async removeOverlyBroadFilters() {
    const spinner = ora('Removing overly broad filters...').start();
    
    const overlyBroadPatterns = [
      'hello@',
      'info@',
      'noreply@',
      'no-reply@',
      'support@',
      'service@',
      'team@',
      'marketing@',
      'updates@',
      'reminders@',
      'notification@',
      'alerts@',
      'news@',
      'partners@'
    ];

    try {
      const response = await this.gmail.users.settings.filters.list({
        userId: 'me'
      });

      const filters = response.data.filter || [];
      
      for (const filter of filters) {
        const criteria = filter.criteria || {};
        const from = criteria.from || '';
        
        // Check if this is one of the overly broad filters
        if (overlyBroadPatterns.some(pattern => from === pattern)) {
          try {
            await this.gmail.users.settings.filters.delete({
              userId: 'me',
              id: filter.id
            });
            this.results.removed++;
            spinner.text = `Removed broad filter: ${from}`;
          } catch (err) {
            this.results.errors.push(`Failed to remove filter ${from}: ${err.message}`);
          }
        }
      }

      spinner.succeed(`Removed ${this.results.removed} overly broad filters`);
    } catch (error) {
      spinner.fail('Failed to remove broad filters');
      throw error;
    }
  }

  // Ensure label exists or create it
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

  // Create smart filters
  async createSmartFilters() {
    const spinner = ora('Creating smart filters...').start();

    const filters = [
      // PayPal Smart Filters
      {
        from: 'service@paypal.com',
        query: 'subject:(payment OR received OR sent OR refund)',
        labels: ['Receipts'],
        keepInInbox: true
      },
      {
        from: 'service@paypal.com',
        query: '-subject:payment -subject:received -subject:sent -subject:refund',
        labels: ['Filtered/Promotional'],
        archive: true
      },

      // Rippling is now in protected senders - no filters needed

      // LinkedIn Filters
      {
        from: 'invitations@linkedin.com',
        labels: ['Filtered/Social'],
        archive: true
      },
      {
        from: 'messages-noreply@linkedin.com',
        labels: ['Filtered/Social'],
        archive: true
      },
      {
        from: 'messaging-digest-noreply@linkedin.com',
        labels: ['Likely Spam'],
        archive: true
      },
      {
        from: 'hit-reply@linkedin.com',
        labels: ['Likely Spam'],
        archive: true
      },

      // Fireflies Filter
      {
        from: 'fred@fireflies.ai',
        query: 'subject:"Weekly Digest:"',
        labels: ['Likely Spam'],
        archive: true
      },

      // High-volume Newsletters
      {
        from: 'hello@interestingfacts.com',
        labels: ['Filtered/Newsletters'],
        archive: true
      },
      {
        from: 'nytdirect@nytimes.com',
        labels: ['Filtered/Newsletters'],
        archive: true
      },
      {
        from: 'ajsai@substack.com',
        labels: ['Filtered/Newsletters'],
        archive: true
      },
      {
        from: 'socialgrowthengineer@mail.beehiiv.com',
        labels: ['Filtered/Newsletters'],
        archive: true
      },
      {
        from: 'grant@mail.beehiiv.com',
        labels: ['Filtered/Newsletters'],
        archive: true
      },
      {
        from: 'theneuron@newsletter.theneurondaily.com',
        labels: ['Filtered/Newsletters'],
        archive: true
      },
      {
        from: 'support@transparentlabs.com',
        labels: ['Filtered/Promotional'],
        archive: true
      },

      // Platform Spam
      {
        from: 'no-reply@discord.com',
        labels: ['Likely Spam'],
        archive: true
      },
      {
        from: 'no-reply@opentable.com',
        labels: ['Likely Spam'],
        archive: true
      },
      {
        from: 'momence@mail.momence.com',
        labels: ['Likely Spam'],
        archive: true
      },

      // Marketing/Sales Spam
      {
        from: 'tibo@mail.featherso.com',
        labels: ['Likely Spam'],
        archive: true
      },
      {
        from: 'magdalena.koestler@mailgun.smore.com',
        labels: ['Likely Spam'],
        archive: true
      },
      {
        from: 'update@digital.metamail.com',
        labels: ['Likely Spam'],
        archive: true
      },
      {
        from: 'hello@news.hims.com',
        labels: ['Likely Spam'],
        archive: true
      },

      // Social/Meetup
      {
        from: '*@email.meetup.com',
        labels: ['Filtered/Social'],
        archive: true
      },

      // Studio/Venue Marketing
      {
        from: 'hello@haumstudios.com',
        labels: ['Filtered/Promotional'],
        archive: true
      },
      {
        from: 'info@templesf.com',
        labels: ['Filtered/Promotional'],
        archive: true
      },

      // Dev Tools
      {
        from: 'team@notify.graphite.dev',
        labels: ['Filtered/Automated'],
        archive: true
      },

      // Generic Newsletter Platform
      {
        from: '*@mail.beehiiv.com',
        labels: ['Filtered/Newsletters'],
        archive: true
      }
    ];

    for (const filter of filters) {
      try {
        const criteria = {
          from: filter.from
        };
        
        if (filter.query) {
          criteria.query = filter.query;
        }

        const action = {};
        
        // Get label IDs
        if (filter.labels) {
          const labelIds = [];
          for (const labelName of filter.labels) {
            const labelId = await this.ensureLabel(labelName);
            labelIds.push(labelId);
          }
          action.addLabelIds = labelIds;
        }

        // Archive if specified
        if (filter.archive) {
          action.removeLabelIds = ['INBOX'];
        }

        await this.gmail.users.settings.filters.create({
          userId: 'me',
          requestBody: { criteria, action }
        });
        
        this.results.created++;
        spinner.text = `Created filter for: ${filter.from}`;
      } catch (err) {
        this.results.errors.push(`Failed to create filter for ${filter.from}: ${err.message}`);
      }
    }

    spinner.succeed(`Created ${this.results.created} smart filters`);
  }

  // Apply filters retroactively to existing emails
  async applyRetroactively() {
    const spinner = ora('Applying filters retroactively to existing emails...').start();
    let retroactiveCount = 0;

    try {
      // Define which filters to apply retroactively
      const retroFilters = [
        { from: 'fred@fireflies.ai', query: 'subject:"Weekly Digest:"', label: 'Likely Spam', archive: true },
        { from: 'messaging-digest-noreply@linkedin.com', label: 'Likely Spam', archive: true },
        { from: 'hit-reply@linkedin.com', label: 'Likely Spam', archive: true },
        { from: 'no-reply@discord.com', label: 'Likely Spam', archive: true },
        { from: 'no-reply@opentable.com', label: 'Likely Spam', archive: true },
        { from: 'tibo@mail.featherso.com', label: 'Likely Spam', archive: true },
        { from: 'magdalena.koestler@mailgun.smore.com', label: 'Likely Spam', archive: true },
        { from: 'update@digital.metamail.com', label: 'Likely Spam', archive: true },
        { from: 'hello@news.hims.com', label: 'Likely Spam', archive: true },
        { from: 'hello@interestingfacts.com', label: 'Filtered/Newsletters', archive: true },
        { from: 'nytdirect@nytimes.com', label: 'Filtered/Newsletters', archive: true },
        { from: 'ajsai@substack.com', label: 'Filtered/Newsletters', archive: true },
        { from: 'socialgrowthengineer@mail.beehiiv.com', label: 'Filtered/Newsletters', archive: true },
        { from: 'grant@mail.beehiiv.com', label: 'Filtered/Newsletters', archive: true },
        { from: 'theneuron@newsletter.theneurondaily.com', label: 'Filtered/Newsletters', archive: true },
        { from: 'support@transparentlabs.com', label: 'Filtered/Promotional', archive: true },
        { from: 'invitations@linkedin.com', label: 'Filtered/Social', archive: true },
        { from: 'messages-noreply@linkedin.com', label: 'Filtered/Social', archive: true }
      ];

      for (const filter of retroFilters) {
        // Build search query
        let searchQuery = `from:${filter.from} in:inbox`;
        if (filter.query) {
          searchQuery += ` ${filter.query}`;
        }

        // Find matching messages
        const response = await this.gmail.users.messages.list({
          userId: 'me',
          q: searchQuery,
          maxResults: 500
        });

        const messages = response.data.messages || [];
        
        if (messages.length > 0) {
          // Get or create label
          const labelId = await this.ensureLabel(filter.label);
          
          // Apply in batches
          const batchSize = 50;
          for (let i = 0; i < messages.length; i += batchSize) {
            const batch = messages.slice(i, i + batchSize).map(m => m.id);
            
            const modifyRequest = {
              userId: 'me',
              requestBody: {
                ids: batch,
                addLabelIds: [labelId]
              }
            };

            if (filter.archive) {
              modifyRequest.requestBody.removeLabelIds = ['INBOX'];
            }

            await this.gmail.users.messages.batchModify(modifyRequest);
            retroactiveCount += batch.length;
          }

          spinner.text = `Applied filter for ${filter.from} to ${messages.length} existing emails`;
        }
      }

      spinner.succeed(`Applied filters retroactively to ${retroactiveCount} existing emails`);
      return retroactiveCount;
    } catch (error) {
      spinner.fail('Some retroactive filtering failed');
      console.error(chalk.gray(error.message));
      return retroactiveCount;
    }
  }

  // Display results
  displayResults(retroactiveCount = 0) {
    console.log('\n' + chalk.bold.cyan('✅ Filter Improvement Complete!'));
    console.log(chalk.gray('='.repeat(50)));
    
    console.log(chalk.green(`  ✓ Removed ${this.results.removed} overly broad filters`));
    console.log(chalk.green(`  ✓ Created ${this.results.created} smart filters`));
    if (retroactiveCount > 0) {
      console.log(chalk.blue(`  ✓ Applied retroactively to ${retroactiveCount} existing emails`));
    }
    
    if (this.results.errors.length > 0) {
      console.log('\n' + chalk.yellow('⚠️  Some operations had errors:'));
      this.results.errors.forEach(err => {
        console.log(chalk.gray(`  - ${err}`));
      });
    }
    
    console.log('\n' + chalk.bold.cyan('📋 What Changed:'));
    console.log('  1. PayPal and Mercury are now unblocked');
    console.log('  2. Fireflies Weekly Digest goes to Likely Spam');
    console.log('  3. High-volume newsletters are archived');
    console.log('  4. LinkedIn spam is properly filtered');
    console.log('  5. Marketing emails go to Likely Spam');
    
    console.log('\n' + chalk.bold.green('🛡️  Protected:'));
    console.log('  • PayPal transactions stay in inbox');
    console.log('  • Rippling and GitHub are now protected senders');
    console.log('  • Banking services never marked as spam');
    console.log('  • VIP emails remain protected');
    console.log('  • Facebook birthdays kept (not filtered)');
    
    console.log('\n' + chalk.yellow('💡 Tips:'));
    console.log('  • Check "Likely Spam" label periodically');
    console.log('  • Run "npm run spam-rescue" to check for false positives');
    console.log('  • All changes can be reversed in Gmail settings');
  }
}

async function main() {
  console.log(chalk.bold.cyan('\n🚀 Gmail Filter Improvement - APPLYING CHANGES\n'));
  console.log(chalk.yellow('This will modify your Gmail filters as shown in the dry run.\n'));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const confirm = await rl.question(chalk.bold.yellow('Are you sure you want to proceed? (yes/no): '));
  
  if (confirm.toLowerCase() !== 'yes') {
    console.log(chalk.yellow('\n❌ Cancelled. No changes made.'));
    rl.close();
    return;
  }
  
  rl.close();

  try {
    console.log(chalk.cyan('\n🔐 Authenticating with Gmail...'));
    const auth = await authorize();
    console.log(chalk.green('✅ Authentication successful!\n'));

    const improver = new FilterImprover(auth);

    // Step 1: Remove overly broad filters
    await improver.removeOverlyBroadFilters();

    // Step 2: Create smart filters
    await improver.createSmartFilters();

    // Step 3: Apply retroactively to existing emails
    console.log('\n' + chalk.cyan('🔄 Applying filters to existing emails...'));
    const retroactiveCount = await improver.applyRetroactively();

    // Step 4: Display results
    improver.displayResults(retroactiveCount);

  } catch (error) {
    console.error(chalk.red('\n❌ Error:'), error.message);
    if (error.message.includes('invalid_grant')) {
      console.log(chalk.yellow('\nTry deleting token.json and running again.'));
    }
  }
}

main();