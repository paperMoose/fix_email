import { authorize } from './auth.js';
import { google } from 'googleapis';
import chalk from 'chalk';
import ora from 'ora';
import readline from 'readline/promises';
import dotenv from 'dotenv';

dotenv.config();

class ReadEmailArchiver {
  constructor(auth) {
    this.gmail = google.gmail({ version: 'v1', auth });
    this.vipEmails = process.env.VIP_EMAILS ? process.env.VIP_EMAILS.split(',').map(e => e.trim().toLowerCase()) : [];
    this.protectedSenders = process.env.PROTECTED_SENDERS ? process.env.PROTECTED_SENDERS.split(',').map(e => e.trim().toLowerCase()) : [];
    this.stats = {
      found: 0,
      archived: 0,
      skipped: 0
    };
  }

  // Extract email from From field
  extractEmail(fromField) {
    const match = fromField.match(/<(.+?)>/) || fromField.match(/([^\s]+@[^\s]+)/);
    return match ? match[1] : fromField;
  }

  // Check if email should be protected from archiving
  isProtected(email) {
    const fromEmail = email.fromEmail.toLowerCase();
    const subject = email.subject.toLowerCase();
    
    // Always protect VIP emails
    if (this.vipEmails.includes(fromEmail)) {
      return true;
    }
    
    // Always protect protected senders
    if (this.protectedSenders.includes(fromEmail)) {
      return true;
    }
    
    // Protect recent emails (last 7 days)
    const emailDate = new Date(email.date);
    const daysSinceEmail = (Date.now() - emailDate) / (1000 * 60 * 60 * 24);
    if (daysSinceEmail < 7) {
      return true;
    }
    
    // Protect emails with important keywords
    const importantKeywords = [
      'invoice', 'receipt', 'payment', 'confirmation',
      'appointment', 'meeting', 'interview', 'urgent',
      'important', 'action required', 'deadline'
    ];
    
    if (importantKeywords.some(keyword => subject.includes(keyword))) {
      return true;
    }
    
    return false;
  }

  // Find read emails in inbox
  async findReadEmails(maxResults = 500) {
    const spinner = ora('Finding read emails in inbox...').start();
    
    try {
      // Query for read emails in inbox (not unread)
      const response = await this.gmail.users.messages.list({
        userId: 'me',
        q: 'in:inbox -is:unread',
        maxResults: maxResults
      });

      const messages = response.data.messages || [];
      this.stats.found = messages.length;
      
      spinner.succeed(`Found ${messages.length} read emails in inbox`);
      
      // Get details for each message
      const emailDetails = [];
      const batchSize = 20;
      
      spinner.start('Analyzing emails...');
      
      for (let i = 0; i < messages.length; i += batchSize) {
        const batch = messages.slice(i, i + batchSize);
        
        const details = await Promise.all(
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
              const fromEmail = this.extractEmail(from);
              
              return {
                id: msg.id,
                from,
                fromEmail,
                subject: headers.subject || '',
                date: headers.date || '',
                labels: detail.data.labelIds || []
              };
            } catch (err) {
              return null;
            }
          })
        );
        
        emailDetails.push(...details.filter(d => d));
        spinner.text = `Analyzed ${Math.min(i + batchSize, messages.length)} of ${messages.length} emails`;
      }
      
      spinner.succeed('Email analysis complete');
      
      // Separate protected and archivable emails
      const archivable = [];
      const protectedEmails = [];
      
      emailDetails.forEach(email => {
        if (this.isProtected(email)) {
          protectedEmails.push(email);
        } else {
          archivable.push(email);
        }
      });
      
      return { archivable, protected: protectedEmails };
    } catch (error) {
      spinner.fail('Failed to find read emails');
      throw error;
    }
  }

  // Display summary of what will be archived
  displaySummary(archivable, protectedEmails) {
    console.log('\n' + chalk.bold.cyan('📊 Read Email Analysis'));
    console.log(chalk.gray('='.repeat(50)));
    
    console.log(chalk.bold(`Total read emails in inbox: ${this.stats.found}`));
    console.log(chalk.green(`📁 Can be archived: ${archivable.length}`));
    console.log(chalk.yellow(`🛡️  Protected (will keep): ${protectedEmails.length}`));
    
    if (protectedEmails.length > 0) {
      console.log('\n' + chalk.bold.yellow('Protected emails (will NOT archive):'));
      console.log(chalk.gray('• VIP emails'));
      console.log(chalk.gray('• Protected senders'));
      console.log(chalk.gray('• Emails from last 7 days'));
      console.log(chalk.gray('• Emails with important keywords'));
      
      // Show sample of protected emails
      console.log('\n' + chalk.gray('Sample protected emails:'));
      protectedEmails.slice(0, 5).forEach(email => {
        const subject = email.subject.length > 50 ? 
          email.subject.substring(0, 50) + '...' : email.subject;
        console.log(chalk.gray(`  • ${email.fromEmail}: "${subject}"`));
      });
    }
    
    if (archivable.length > 0) {
      console.log('\n' + chalk.bold.green('Emails to archive:'));
      
      // Group by sender
      const bySender = {};
      archivable.forEach(email => {
        if (!bySender[email.fromEmail]) {
          bySender[email.fromEmail] = 0;
        }
        bySender[email.fromEmail]++;
      });
      
      // Show top senders
      const topSenders = Object.entries(bySender)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
        
      console.log(chalk.gray('Top senders to be archived:'));
      topSenders.forEach(([sender, count]) => {
        console.log(chalk.gray(`  • ${sender} (${count} emails)`));
      });
      
      // Calculate age distribution
      const now = Date.now();
      const ageGroups = {
        week: 0,
        month: 0,
        older: 0
      };
      
      archivable.forEach(email => {
        const age = (now - new Date(email.date)) / (1000 * 60 * 60 * 24);
        if (age <= 7) ageGroups.week++;
        else if (age <= 30) ageGroups.month++;
        else ageGroups.older++;
      });
      
      console.log('\n' + chalk.gray('Age of emails to archive:'));
      console.log(chalk.gray(`  • 1-7 days old: ${ageGroups.week}`));
      console.log(chalk.gray(`  • 8-30 days old: ${ageGroups.month}`));
      console.log(chalk.gray(`  • Older than 30 days: ${ageGroups.older}`));
    }
  }

  // Archive emails
  async archiveEmails(emails) {
    const spinner = ora('Archiving read emails...').start();
    
    try {
      // Process in batches
      const batchSize = 50;
      
      for (let i = 0; i < emails.length; i += batchSize) {
        const batch = emails.slice(i, i + batchSize);
        const ids = batch.map(e => e.id);
        
        await this.gmail.users.messages.batchModify({
          userId: 'me',
          requestBody: {
            ids: ids,
            removeLabelIds: ['INBOX']
          }
        });
        
        this.stats.archived += ids.length;
        spinner.text = `Archived ${Math.min(i + batchSize, emails.length)} of ${emails.length} emails`;
      }
      
      spinner.succeed(`✅ Archived ${this.stats.archived} read emails`);
    } catch (error) {
      spinner.fail('Failed to archive some emails');
      throw error;
    }
  }
}

async function main() {
  console.log(chalk.bold.cyan('\n📚 Archive Read Emails Tool\n'));
  console.log(chalk.gray('This tool archives read emails from your inbox while protecting important ones.\n'));

  try {
    console.log(chalk.cyan('🔐 Authenticating with Gmail...'));
    const auth = await authorize();
    console.log(chalk.green('✅ Authentication successful!\n'));

    const archiver = new ReadEmailArchiver(auth);
    
    // Find read emails
    const { archivable, protected: protectedEmails } = await archiver.findReadEmails(1000);
    
    // Display summary
    archiver.displaySummary(archivable, protectedEmails);
    
    if (archivable.length === 0) {
      console.log(chalk.yellow('\n✨ No emails to archive. Your inbox is already clean!'));
      return;
    }
    
    // Ask for confirmation
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    const proceed = await rl.question('\n' + 
      chalk.bold.yellow(`Archive ${archivable.length} read emails? (y/n): `));
    
    if (proceed.toLowerCase() === 'y') {
      await archiver.archiveEmails(archivable);
      console.log(chalk.green('\n✅ Read emails have been archived!'));
      console.log(chalk.gray('They remain searchable and can be found in "All Mail"'));
    } else {
      console.log(chalk.yellow('\nNo emails were archived.'));
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