import { authorize } from './auth.js';
import { google } from 'googleapis';
import chalk from 'chalk';
import ora from 'ora';
import readline from 'readline/promises';

class DryRunFilterAnalyzer {
  constructor(auth) {
    this.gmail = google.gmail({ version: 'v1', auth });
    this.changes = {
      filtersToRemove: [],
      filtersToAdd: [],
      protectedEmails: [],
      potentiallyAffected: []
    };
  }

  // Analyze which filters would be removed
  async analyzeFiltersToRemove() {
    const spinner = ora('Analyzing filters to remove...').start();
    
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
          this.changes.filtersToRemove.push({
            id: filter.id,
            from: from,
            action: filter.action,
            reason: 'Overly broad pattern catching legitimate emails'
          });
        }
      }

      spinner.succeed(`Found ${this.changes.filtersToRemove.length} overly broad filters to remove`);
    } catch (error) {
      spinner.fail('Failed to analyze filters');
      throw error;
    }
  }

  // Analyze what legitimate emails might be affected
  async analyzeAffectedEmails() {
    const spinner = ora('Analyzing affected legitimate emails...').start();
    
    const legitimateServices = [
      'service@paypal.com',
      'support@github.com',
      'support@stripe.com',
      'noreply@uber.com',
      'no-reply@rippling.com',
      'hello@mercury.com',
      'team@openai.com',
      'updates@medium.com',
      'notification@linkedin.com',
      'alerts@chase.com',
      'news@bloomberg.com'
    ];

    try {
      // Check recent emails from these services
      for (const service of legitimateServices) {
        const response = await this.gmail.users.messages.list({
          userId: 'me',
          q: `from:${service}`,
          maxResults: 5
        });

        if (response.data.messages && response.data.messages.length > 0) {
          // Check if currently being filtered by broad rules
          const broadPattern = service.split('@')[0] + '@';
          const isCurrentlyFiltered = this.changes.filtersToRemove.some(f => 
            service.startsWith(f.from)
          );

          if (isCurrentlyFiltered) {
            this.changes.potentiallyAffected.push({
              sender: service,
              count: response.data.messages.length,
              currentlyFiltered: true,
              willBeFixed: true
            });
          }
        }
      }

      spinner.succeed(`Analyzed impact on legitimate services`);
    } catch (error) {
      spinner.fail('Failed to analyze affected emails');
      // Continue anyway
    }
  }

  // Define new smart filters that would be created
  defineNewFilters() {
    this.changes.filtersToAdd = [
      // PayPal Smart Filters
      {
        from: 'service@paypal.com',
        condition: 'subject contains: payment, received, sent, refund',
        action: 'Keep in Inbox + Label: Receipts',
        reason: 'Important transaction emails'
      },
      {
        from: 'service@paypal.com',
        condition: 'subject does NOT contain: payment, received, sent, refund',
        action: 'Archive + Label: Filtered/Promotional',
        reason: 'PayPal marketing emails'
      },

      // Rippling HR Filters
      {
        from: 'no-reply@rippling.com',
        condition: 'subject contains: payroll, benefits, tax, urgent',
        action: 'Keep in Inbox + Label: Important/HR',
        reason: 'Critical HR information'
      },
      {
        from: 'no-reply@rippling.com',
        condition: 'subject does NOT contain: payroll, benefits, tax, urgent',
        action: 'Archive + Label: Filtered/Automated',
        reason: 'Routine HR notifications'
      },

      // LinkedIn Improved Filters
      {
        from: 'invitations@linkedin.com',
        condition: 'all emails',
        action: 'Archive + Label: Filtered/Social',
        reason: 'LinkedIn invitations (28 emails)'
      },
      {
        from: 'messages-noreply@linkedin.com',
        condition: 'all emails',
        action: 'Archive + Label: Filtered/Social',
        reason: 'LinkedIn messages'
      },
      {
        from: 'messaging-digest-noreply@linkedin.com',
        condition: 'all emails',
        action: 'Label: Likely Spam + Remove from Inbox',
        reason: 'LinkedIn digest spam (6 emails)'
      },
      {
        from: 'hit-reply@linkedin.com',
        condition: 'all emails',
        action: 'Label: Likely Spam + Remove from Inbox',
        reason: 'LinkedIn spam messages (3 emails)'
      },

      // Fireflies Filter
      {
        from: 'fred@fireflies.ai',
        condition: 'subject contains: Weekly Digest:',
        action: 'Label: Likely Spam + Remove from Inbox',
        reason: 'Fireflies weekly digest spam (per user request)'
      },

      // High-volume Newsletter Filters (from analysis)
      {
        from: 'hello@interestingfacts.com',
        condition: 'all emails',
        action: 'Archive + Label: Filtered/Newsletters',
        reason: 'High-volume newsletter (14 emails)'
      },
      {
        from: 'nytdirect@nytimes.com',
        condition: 'all emails',
        action: 'Archive + Label: Filtered/Newsletters',
        reason: 'High-volume newsletter (12 emails)'
      },
      {
        from: 'ajsai@substack.com',
        condition: 'all emails',
        action: 'Archive + Label: Filtered/Newsletters',
        reason: 'High-volume newsletter (10 emails)'
      },
      {
        from: 'socialgrowthengineer@mail.beehiiv.com',
        condition: 'all emails',
        action: 'Archive + Label: Filtered/Newsletters',
        reason: 'Marketing newsletter (8 emails)'
      },
      {
        from: 'grant@mail.beehiiv.com',
        condition: 'all emails',
        action: 'Archive + Label: Filtered/Newsletters',
        reason: 'Marketing newsletter (7 emails)'
      },
      {
        from: 'theneuron@newsletter.theneurondaily.com',
        condition: 'all emails',
        action: 'Archive + Label: Filtered/Newsletters',
        reason: 'AI newsletter (9 emails)'
      },
      {
        from: 'support@transparentlabs.com',
        condition: 'all emails',
        action: 'Archive + Label: Filtered/Promotional',
        reason: 'Product marketing (9 emails)'
      },

      // Platform Notification Spam
      {
        from: 'no-reply@discord.com',
        condition: 'all emails',
        action: 'Label: Likely Spam + Remove from Inbox',
        reason: 'Discord notifications (8 emails)'
      },
      {
        from: 'no-reply@opentable.com',
        condition: 'all emails',
        action: 'Label: Likely Spam + Remove from Inbox',
        reason: 'Restaurant notifications (3 emails)'
      },
      {
        from: 'momence@mail.momence.com',
        condition: 'all emails',
        action: 'Label: Likely Spam + Remove from Inbox',
        reason: 'Class platform spam'
      },

      // Marketing/Sales Outreach
      {
        from: 'tibo@mail.featherso.com',
        condition: 'all emails',
        action: 'Label: Likely Spam + Remove from Inbox',
        reason: 'Marketing/sales content'
      },
      {
        from: 'magdalena.koestler@mailgun.smore.com',
        condition: 'all emails',
        action: 'Label: Likely Spam + Remove from Inbox',
        reason: 'Suspicious case information emails'
      },
      {
        from: 'update@digital.metamail.com',
        condition: 'all emails',
        action: 'Label: Likely Spam + Remove from Inbox',
        reason: 'Meta marketing (3 emails)'
      },
      {
        from: '@email.meetup.com',
        condition: 'all emails',
        action: 'Archive + Label: Filtered/Social',
        reason: 'Meetup announcements'
      },

      // Product/Subscription Marketing
      {
        from: 'hello@news.hims.com',
        condition: 'all emails',
        action: 'Label: Likely Spam + Remove from Inbox',
        reason: 'Health product marketing (4 emails)'
      },
      {
        from: 'hello@haumstudios.com',
        condition: 'all emails',
        action: 'Archive + Label: Filtered/Promotional',
        reason: 'Studio marketing (5 emails)'
      },
      {
        from: 'info@templesf.com',
        condition: 'all emails',
        action: 'Archive + Label: Filtered/Promotional',
        reason: 'Venue marketing (3 emails)'
      },
      {
        from: 'team@notify.graphite.dev',
        condition: 'all emails',
        action: 'Archive + Label: Filtered/Automated',
        reason: 'Dev tool notifications'
      },

      // Generic Spam Patterns
      {
        from: '@mail.beehiiv.com',
        condition: 'all emails not already filtered',
        action: 'Archive + Label: Filtered/Newsletters',
        reason: 'Newsletter platform emails'
      },
      {
        from: 'contains: winner@, prize@, rewards@',
        condition: 'NOT from major banks/retailers',
        action: 'Label: Likely Spam + Remove from Inbox',
        reason: 'Common spam patterns'
      },
      {
        subject: 'contains: congratulations you won, claim your prize',
        condition: 'all emails',
        action: 'Label: Likely Spam + Remove from Inbox',
        reason: 'Classic spam subjects'
      }
    ];
  }

  // Analyze current inbox to show impact
  async analyzeInboxImpact() {
    const spinner = ora('Analyzing inbox impact...').start();
    
    try {
      // Get current inbox stats
      const inboxResponse = await this.gmail.users.messages.list({
        userId: 'me',
        labelIds: ['INBOX'],
        maxResults: 100
      });

      const messages = inboxResponse.data.messages || [];
      let wouldArchive = 0;
      let wouldLabel = 0;
      let wouldProtect = 0;

      // Sample check on what would happen
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
          
          // Check against our rules
          if (from.includes('paypal.com') || from.includes('rippling.com')) {
            wouldProtect++;
          } else if (from.includes('linkedin.com') || from.includes('newsletter')) {
            wouldArchive++;
          } else {
            wouldLabel++;
          }
        } catch (err) {
          // Skip
        }
      }

      spinner.succeed('Analyzed inbox impact');
      
      return {
        totalInInbox: messages.length,
        sampleSize: Math.min(50, messages.length),
        wouldArchive,
        wouldLabel,
        wouldProtect
      };
    } catch (error) {
      spinner.fail('Failed to analyze inbox');
      return null;
    }
  }

  // Display dry run results
  displayDryRunResults(inboxImpact) {
    console.log('\n' + chalk.bold.cyan('🔍 DRY RUN RESULTS - No Changes Made'));
    console.log(chalk.gray('='.repeat(50)));

    // Filters to remove
    console.log('\n' + chalk.bold.red(`📝 ${this.changes.filtersToRemove.length} Overly Broad Filters to Remove:`));
    this.changes.filtersToRemove.forEach(f => {
      console.log(chalk.red(`  ✗ Remove: "From: ${f.from}"`));
      console.log(chalk.gray(`    Reason: ${f.reason}`));
    });

    // Legitimate emails that will be unblocked
    if (this.changes.potentiallyAffected.length > 0) {
      console.log('\n' + chalk.bold.green('✅ Legitimate Services That Will Be Unblocked:'));
      this.changes.potentiallyAffected.forEach(e => {
        console.log(chalk.green(`  ✓ ${e.sender} (${e.count} recent emails)`));
      });
    }

    // New filters to add
    console.log('\n' + chalk.bold.blue(`📬 ${this.changes.filtersToAdd.length} Smart Filters to Add:`));
    
    // Group filters by type for better readability
    const filterGroups = {
      'Smart Service Filters': this.changes.filtersToAdd.filter(f => 
        f.from?.includes('paypal') || f.from?.includes('rippling')),
      'Likely Spam Filters': this.changes.filtersToAdd.filter(f => 
        f.action?.includes('Likely Spam')),
      'Newsletter/Promotional Filters': this.changes.filtersToAdd.filter(f => 
        f.action?.includes('Filtered/Newsletters') || f.action?.includes('Filtered/Promotional')),
      'Social/Automated Filters': this.changes.filtersToAdd.filter(f => 
        f.action?.includes('Filtered/Social') || f.action?.includes('Filtered/Automated'))
    };
    
    Object.entries(filterGroups).forEach(([groupName, filters]) => {
      if (filters.length > 0) {
        console.log(chalk.cyan(`\n  ${groupName}:`));
        filters.forEach(f => {
          console.log(chalk.blue(`    + ${f.from || f.subject}`));
          console.log(chalk.gray(`      ${f.reason}`));
        });
      }
    });

    // Protected services
    console.log('\n' + chalk.bold.green('🛡️  Protected Services (Never Marked as Spam):'));
    const protectedServices = [
      'PayPal transactions',
      'Rippling HR/Payroll',
      'Banking (Chase, Capital One, Mercury)',
      'Payment services (Venmo, Stripe)',
      'Delivery (Uber, DoorDash)'
    ];
    protectedServices.forEach(p => console.log(chalk.green(`  ✓ ${p}`)));

    // Inbox impact
    if (inboxImpact) {
      console.log('\n' + chalk.bold.yellow('📊 Estimated Inbox Impact:'));
      console.log(chalk.gray(`  Analyzed ${inboxImpact.sampleSize} of ${inboxImpact.totalInInbox} inbox emails`));
      console.log(chalk.yellow(`  • Would archive: ~${inboxImpact.wouldArchive} emails`));
      console.log(chalk.blue(`  • Would label only: ~${inboxImpact.wouldLabel} emails`));
      console.log(chalk.green(`  • Would protect: ~${inboxImpact.wouldProtect} emails`));
    }

    // Summary
    console.log('\n' + chalk.bold.cyan('📋 Summary of Changes:'));
    console.log(chalk.gray('='.repeat(50)));
    console.log(`  1. Remove ${this.changes.filtersToRemove.length} overly broad filters`);
    console.log(`  2. Add ${this.changes.filtersToAdd.length} smart, specific filters`);
    console.log(`  3. Protect legitimate services from spam filtering`);
    console.log(`  4. Create conditional filters for services like PayPal`);
    
    console.log('\n' + chalk.bold.yellow('⚠️  Important Notes:'));
    console.log(chalk.yellow('  • Archived emails are NOT deleted'));
    console.log(chalk.yellow('  • All changes can be reversed'));
    console.log(chalk.yellow('  • Your VIP list remains protected'));
    console.log(chalk.yellow('  • Transaction/receipt emails stay in inbox'));
  }
}

async function main() {
  console.log(chalk.bold.cyan('\n🔬 Gmail Filter Improvement - DRY RUN MODE\n'));
  console.log(chalk.yellow('This will analyze your filters without making any changes.\n'));

  try {
    console.log(chalk.cyan('🔐 Authenticating with Gmail...'));
    const auth = await authorize();
    console.log(chalk.green('✅ Authentication successful!\n'));

    const analyzer = new DryRunFilterAnalyzer(auth);

    // Step 1: Analyze filters to remove
    await analyzer.analyzeFiltersToRemove();

    // Step 2: Analyze affected emails
    await analyzer.analyzeAffectedEmails();

    // Step 3: Define new filters
    analyzer.defineNewFilters();

    // Step 4: Analyze inbox impact
    const inboxImpact = await analyzer.analyzeInboxImpact();

    // Step 5: Display results
    analyzer.displayDryRunResults(inboxImpact);

    // Ask if user wants to proceed
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const proceed = await rl.question('\n' + chalk.bold.yellow('Would you like to apply these changes? (y/n): '));
    
    if (proceed.toLowerCase() === 'y') {
      console.log(chalk.green('\n✅ Ready to apply changes!'));
      console.log(chalk.cyan('Run: npm run improve-filters'));
    } else {
      console.log(chalk.yellow('\n❌ No changes made. Dry run complete.'));
    }
    
    rl.close();

  } catch (error) {
    console.error(chalk.red('\n❌ Error:'), error.message);
    if (error.message.includes('invalid_grant')) {
      console.log(chalk.yellow('\nTry deleting token.json and running again.'));
    }
  }
}

main();