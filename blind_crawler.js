const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function scrapeTeamblind(config) {
  // 설정 기본값 설정
  const searchKeyword = config.keyword || '폰 대리점';
  const maxPosts = config.maxPosts || 100; // 기본값 100개
  const saveComments = config.saveComments !== false; // 기본적으로 댓글 수집

  // 출력 디렉토리 생성
  const outputDir = './teamblind_data';
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
  }

  // 날짜를 포함한 파일명 생성
  const dateStr = new Date().toISOString().slice(0, 10);
  const outputBaseName = `teamblind_${searchKeyword}_${dateStr}`;
  const outputPath = path.join(outputDir, `${outputBaseName}.json`);
  const tempOutputPath = path.join(outputDir, `${outputBaseName}_temp.json`);
  
  // 브라우저 실행
  const browser = await puppeteer.launch({ 
    headless: false, // 브라우저 화면 표시
    defaultViewport: null, // 뷰포트 자동 조정
    // 타임아웃 제거
    //timeout: config.timeout || 60000 // 타임아웃 60초로 설정
  });
  
  const page = await browser.newPage();
  
  // 페이지 타임아웃 설정
  await page.setDefaultNavigationTimeout(60000);
  
  // 데이터를 저장할 배열
  let posts = [];
  
  // 이전 데이터가 있으면 불러오기
  if (fs.existsSync(tempOutputPath)) {
    try {
      console.log('기존 임시 데이터 파일을 불러옵니다.');
      const tempData = JSON.parse(fs.readFileSync(tempOutputPath, 'utf8'));
      posts = tempData.posts || [];
      console.log(`임시 파일에서 ${posts.length}개의 게시물을 불러왔습니다.`);
    } catch (e) {
      console.error('임시 파일 불러오기 실패:', e);
    }
  }
  
  try {
    // 검색 결과 페이지로 이동
    const encodedKeyword = encodeURIComponent(searchKeyword);
    await page.goto(`https://www.teamblind.com/kr/search/${encodedKeyword}`, {
      waitUntil: 'networkidle2'
    });
    
    console.log(`"${searchKeyword}" 키워드로 검색한, 팀블라인드 검색 결과 페이지를 스크랩합니다.`);
    
    let previousHeight = 0;
    let isEnd = false;
    let scrollCount = 0;
    let lastNewPostCount = 0;
    let noNewPostsCounter = 0;
    let startTime = Date.now();
    const maxExecutionTime = 20 * 60 * 1000; // 최대 실행 시간 20분
    
    // 총 게시물 수 파악
    const totalPostCount = await page.evaluate(() => {
      const searchResultInfo = document.querySelector('.tab-contents .result-info .cnt');
      if (searchResultInfo) {
        const countText = searchResultInfo.textContent.trim();
        const match = countText.match(/[\d,]+/);
        if (match) {
          return parseInt(match[0].replace(/,/g, ''));
        }
      }
      return null; // 총 개수를 찾을 수 없는 경우
    });
    
    const effectiveTotal = totalPostCount || maxPosts;
    console.log(`검색 결과에서 확인된 총 게시물 수: ${totalPostCount || '알 수 없음'}, 목표 수집: ${maxPosts}개`);
    
    // 중간 저장 함수
    const saveTemporaryData = () => {
      fs.writeFileSync(tempOutputPath, JSON.stringify({
        keyword: searchKeyword,
        count: posts.length,
        lastUpdated: new Date().toISOString(),
        posts: posts
      }, null, 2));
      console.log(`임시 데이터가 ${tempOutputPath}에 저장되었습니다.`);
    };
    
    // 본문 내용 수집 함수
    const collectFullContent = async (url) => {
      let retryCount = 0;
      const maxRetries = 3;

      while (retryCount < maxRetries) {
        try {
          await page.goto(url, { waitUntil: 'networkidle2' });
          
          return await page.evaluate(() => {
            // 본문 내용 셀렉터 - 팀블라인드 구조에 맞게 수정
            const contentEl = document.querySelector('.article-view-contents #contentArea.contents-txt');
            
            if (!contentEl) {
              // 다양한 대체 셀렉터 시도
              const alternateSelectors = [
                '.article-view-contents .contents-txt',
                '[data-v-a4bba3f8].contents-txt',
                '.article-body', 
                '.content',
                '.article-content',
                '[class*="article-view"] [class*="contents"]',
                '.post-content',
                '.post-body'
              ];
              
              for (const selector of alternateSelectors) {
                const altEl = document.querySelector(selector);
                if (altEl && altEl.textContent.trim()) {
                  return altEl.textContent.trim();
                }
              }
              
              return ''; // 본문을 찾지 못한 경우
            }
            
            // 본문 텍스트
            return contentEl.textContent.trim();
          });
        } catch (error) {
          retryCount++;
          console.error(`본문 수집 실패 (${retryCount}/${maxRetries}): ${error.message}`);
          
          if (retryCount >= maxRetries) {
            console.error(`최대 재시도 횟수(${maxRetries})를 초과했습니다. 본문 수집을 건너뜁니다.`);
            return ''; // 최대 재시도 횟수 초과 시 빈 문자열 반환
          }
          
          // 재시도 전 대기
          await new Promise(resolve => setTimeout(resolve, 3000 * retryCount));
        }
      }
    };
    
    // 댓글 수집 함수
    const collectComments = async (url) => {
      if (!saveComments) return []; // 댓글 수집 비활성화된 경우
      
      let retryCount = 0;
      const maxRetries = 3;
      
      while (retryCount < maxRetries) {
        try {
          // 이미 해당 URL에 있지 않으면 이동
          const currentUrl = await page.url();
          if (currentUrl !== url) {
            await page.goto(url, { waitUntil: 'networkidle2' });
          }
          
          // "더보기" 버튼 클릭 - 대댓글 펼치기
          const expandReplies = async () => {
            return await page.evaluate(() => {
              const moreBtns = Array.from(document.querySelectorAll('button.btn-reply'));
              let clicked = 0;
              
              for (const btn of moreBtns) {
                if (btn.textContent.includes('대댓글') || btn.textContent.includes('더보기')) {
                  btn.click();
                  clicked++;
                }
              }
              return clicked;
            });
          };
          
          // 대댓글 확장 버튼 클릭
          let expandedCount = await expandReplies();
          if (expandedCount > 0) {
            console.log(`${expandedCount}개의 대댓글 더보기 버튼을 클릭했습니다.`);
            // 대댓글 로딩 대기
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
          
          // 모든 댓글 수집
          const comments = await page.evaluate(() => {
            // 실제 팀블라인드 댓글 구조에 맞게 셀렉터 수정
            const commentElements = Array.from(document.querySelectorAll('.wrap-comment.comment_area'));
            const results = [];
            
            for (const commentEl of commentElements) {
              try {
                // 댓글 내용이 없는 요소 무시 (댓글 작성 폼 등)
                if (!commentEl.textContent.trim()) continue;
                
                // 회사명
                const companyEl = commentEl.querySelector('a.point');
                const company = companyEl ? companyEl.textContent.trim() : '';
                
                // 닉네임 - 회사명 다음에 오는 텍스트
                const nameEl = commentEl.querySelector('p.name');
                let nickname = '';
                if (nameEl) {
                  const nameText = nameEl.textContent.trim();
                  // 회사명 이후의 · 뒤에 오는 부분이 닉네임
                  const parts = nameText.split('·');
                  if (parts.length > 1) {
                    nickname = parts[1].trim();
                  }
                }
                
                // 작성자 여부 확인
                const isAuthor = !!commentEl.querySelector('em.op');
                
                // 내용
                const contentEl = commentEl.querySelector('p.cmt-txt');
                const content = contentEl ? contentEl.textContent.trim() : '';
                
                // 이미지 첨부 확인
                const hasImage = !!commentEl.querySelector('p.attach-img');
                
                // 날짜
                const dateEl = commentEl.querySelector('span.date');
                let date = '';
                if (dateEl) {
                  const dateText = dateEl.textContent.trim();
                  // '작성일2019.11.28.' 형식에서 날짜만 추출
                  const dateMatch = dateText.match(/\d{4}\.\d{1,2}\.\d{1,2}/);
                  date = dateMatch ? dateMatch[0] : dateText.replace(/작성일/i, '').trim();
                }
                
                // 좋아요 수
                const likeEl = commentEl.querySelector('span.like, a.like');
                let likes = 0;
                if (likeEl) {
                  const likeText = likeEl.textContent.trim();
                  if (likeText !== '좋아요' && likeText !== '좋아요수좋아요') {
                    const likeMatch = likeText.match(/\d+/);
                    if (likeMatch) {
                      likes = parseInt(likeMatch[0]);
                    }
                  }
                }
                
                // 대댓글 여부 확인 - class="wrap-reply" 내부에 있으면 대댓글
                const isReply = !!commentEl.closest('.wrap-reply');
                
                // 대댓글 수
                const commentCountEl = commentEl.querySelector('span.cmt');
                let commentCount = 0;
                if (commentCountEl) {
                  const cmtText = commentCountEl.textContent.trim();
                  if (cmtText !== '대댓글') {
                    const cmtMatch = cmtText.match(/\d+/);
                    if (cmtMatch) {
                      commentCount = parseInt(cmtMatch[0]);
                    }
                  }
                }
                
                // 댓글 ID (고유 ID 속성 가져오기)
                const commentId = commentEl.id || '';
                
                results.push({
                  id: commentId,
                  nickname,
                  company,
                  content,
                  date,
                  likes,
                  hasImage,
                  commentCount,
                  isReply,
                  isAuthor
                });
              } catch (e) {
                console.error('댓글 파싱 중 오류:', e);
              }
            }
            
            return results;
          });
          
          return comments;
        } catch (error) {
          retryCount++;
          console.error(`댓글 수집 실패 (${retryCount}/${maxRetries}): ${error.message}`);
          
          if (retryCount >= maxRetries) {
            console.error(`최대 재시도 횟수(${maxRetries})를 초과했습니다. 댓글 수집을 건너뜁니다.`);
            return []; // 최대 재시도 횟수 초과 시 빈 배열 반환
          }
          
          // 재시도 전 대기
          await new Promise(resolve => setTimeout(resolve, 3000 * retryCount));
        }
      }
    };
    
    // 무한 스크롤 처리
    while (!isEnd && scrollCount < 40 && posts.length < maxPosts) { // 최대 40회 스크롤 또는 설정한 게시물 수에 도달할 때까지
      // 현재 스크랩된 게시물 개수 출력 및 진행률 계산
      const progressPercent = Math.min(100, Math.round(posts.length / effectiveTotal * 100));
      console.log(`현재 ${posts.length}개의 게시물이 스크랩되었습니다. (목표: ${maxPosts}개, 진행률: ${progressPercent}%)`);
      
      // 최대 실행 시간 체크
      const currentTime = Date.now();
      if (currentTime - startTime > maxExecutionTime) {
        console.log(`최대 실행 시간(${maxExecutionTime / 60000}분)을 초과하여 스크롤을 종료합니다.`);
        isEnd = true;
        break;
      }
      
      // 게시물 목록 가져오기
      const newPosts = await page.evaluate(async (currentPosts, keyword) => {
        const postElements = Array.from(document.querySelectorAll('.article-list-pre:not(.article-list-ad):not(.coupang-ad)'));
        const results = [];
        const seenUrls = new Set(currentPosts.map(p => p.url));
        
        for (const postEl of postElements) {
          try {
            // 이미 수집한 게시물인지 확인 (URL로 체크)
            const linkElement = postEl.querySelector('.tit a');
            const postUrl = linkElement ? linkElement.href : null;
            if (!postUrl || seenUrls.has(postUrl)) continue;
            
            // URL 추가
            seenUrls.add(postUrl);
            
            // 제목
            const titleElement = postEl.querySelector('.tit h3');
            const title = titleElement ? titleElement.textContent.trim() : '';
            if (!title) continue; // 제목이 없는 게시물은 건너뛰기
            
            // 내용 미리보기
            const previewElement = postEl.querySelector('.pre-txt a');
            const previewText = previewElement ? previewElement.textContent.trim() : '';
            
            // 작성자 정보
            const authorElement = postEl.querySelector('.sub .name a');
            const authorText = authorElement ? authorElement.textContent.trim() : '';
            // 회사와 사용자명 분리
            const authorParts = authorText.split('·');
            const company = authorParts[0]?.trim() || '';
            const author = authorParts[1]?.trim() || '';
            
            // 조회수
            const viewElement = postEl.querySelector('.pv');
            const views = viewElement ? 
              parseInt(viewElement.textContent.replace(/[^0-9]/g, '')) || 0 : 0;
            
            // 좋아요
            const likeElement = postEl.querySelector('.like');
            const likeText = likeElement ? likeElement.textContent.trim() : '좋아요';
            const likes = likeText !== '좋아요' ? parseInt(likeText.replace(/[^0-9]/g, '')) || 0 : 0;
            
            // 댓글 수
            const commentElement = postEl.querySelector('.cmt');
            const commentCount = commentElement ? 
              parseInt(commentElement.textContent.replace(/[^0-9]/g, '')) || 0 : 0;
            
            // 날짜
            const dateElement = postEl.querySelector('.past');
            const date = dateElement ? dateElement.textContent.replace(/[_작성시간_]/g, '').trim() : '';
            
            // 카테고리
            const categoryElement = postEl.querySelector('.category .topic-name');
            const category = categoryElement ? categoryElement.textContent.trim() : '';
            
            results.push({
              keyword,
              title,
              url: postUrl,
              preview: previewText,
              company,
              author,
              category,
              date,
              views,
              likes,
              commentCount,
              fullContent: '', // 나중에 상세 페이지에서 채울 예정
              comments: [] // 댓글은 나중에 수집
            });
          } catch (e) {
            console.error('게시물 파싱 중 오류:', e);
          }
        }
        
        return results;
      }, posts, searchKeyword);
      
      // 새 게시물 추가
      const prevPostCount = posts.length;
      posts.push(...newPosts);
      const currentPostCount = posts.length;
      const newPostCountThisScroll = currentPostCount - prevPostCount;
      
      // 새 게시물이 추가되지 않은 경우 카운터 증가
      if (newPostCountThisScroll === 0) {
        noNewPostsCounter++;
        console.log(`새 게시물이 발견되지 않았습니다. (${noNewPostsCounter}/3)`);
        
        // 3번 연속으로 새 게시물이 없으면 종료
        if (noNewPostsCounter >= 3) {
          console.log('3번 연속으로 새 게시물이 발견되지 않아 스크롤을 종료합니다.');
          isEnd = true;
          break;
        }
      } else {
        noNewPostsCounter = 0; // 새 게시물이 있으면 카운터 초기화
      }
      
      // 설정한 최대 게시물 수를 초과한 경우 잘라내기
      if (posts.length > maxPosts) {
        console.log(`설정한 최대 게시물 수(${maxPosts}개)를 초과했습니다. 초과분을 제거합니다.`);
        posts = posts.slice(0, maxPosts);
        isEnd = true; // 스크롤 중단
        break;
      }
      
      // 총 게시물 수와 비교하여 종료 여부 결정
      if (totalPostCount && posts.length >= totalPostCount) {
        console.log(`모든 게시물(${totalPostCount}개)을 수집했습니다. 스크롤을 종료합니다.`);
        isEnd = true;
        break;
      }
      
      // 새 게시물이 추가되었으면 임시 파일에 저장
      if (newPosts.length > 0) {
        saveTemporaryData();
        // 메모리 사용량 로깅 (디버깅용)
        const memoryUsage = process.memoryUsage();
        console.log(`메모리 사용량: ${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB / ${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`);
      }
      
      // 스크롤 내리기
      previousHeight = await page.evaluate('document.body.scrollHeight');
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      
      // 로딩 대기 (직접 타임아웃 처리)
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // 스크롤이 더 이상 내려가지 않는지 확인
      const currentHeight = await page.evaluate('document.body.scrollHeight');
      if (currentHeight === previousHeight) {
        console.log('더 이상 스크롤 할 수 없습니다. 스크래핑을 종료합니다.');
        isEnd = true;
      }
      
      scrollCount++;
      console.log(`스크롤 ${scrollCount}/40 완료`);
    }
    
    console.log(`총 ${posts.length}개의 게시물을 찾았습니다.`);
    
    // 게시물 상세 내용 수집
    console.log("이제 각 게시물의 상세 내용을 수집합니다.");
    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      
      // 이미 상세 내용이 수집된 게시물 건너뛰기
      if (post.fullContent && post.fullContent.length > 0) {
        console.log(`게시물 ${i+1}/${posts.length} "${post.title}"의 상세 내용은 이미 수집되었습니다.`);
        continue;
      }
      
      // 상세 내용 수집 진행률 표시
      const detailProgressPercent = Math.round((i / posts.length) * 100);
      console.log(`게시물 ${i+1}/${posts.length} "${post.title}" 상세 내용 수집 중... (${detailProgressPercent}%)`);
      
      try {
        // 본문 수집
        const fullContent = await collectFullContent(post.url);
        posts[i].fullContent = fullContent;
        console.log(`게시물 "${post.title}"의 본문 내용을 수집했습니다. 글자 수: ${fullContent.length}`);
        
        // 댓글 수집
        if (saveComments) {
          const comments = await collectComments(post.url);
          posts[i].comments = comments.filter(c => c.content && c.content.trim().length > 0);
          console.log(`게시물 "${post.title}"에서 총 ${posts[i].comments.length}개의 댓글을 수집했습니다.`);
        }
        
        // 중간 저장
        saveTemporaryData();
        
        // 과도한 요청을 방지하기 위한 지연
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (e) {
        console.error(`게시물 "${post.title}" 상세 내용 수집 중 오류:`, e);
        
        // 오류 정보 저장
        posts[i].error = e.message;
        posts[i].errorAt = new Date().toISOString();
        
        saveTemporaryData(); // 오류가 있어도 중간 저장
        
        // 페이지 문제일 경우 페이지 리로드 시도
        try {
          await page.reload({ waitUntil: 'networkidle2' });
          console.log('페이지 리로드 시도');
          await new Promise(resolve => setTimeout(resolve, 3000)); // 리로드 후 대기
        } catch (reloadError) {
          console.error('페이지 리로드 중 오류:', reloadError);
        }
      }
    }
    
    // 최종 결과 저장
    fs.writeFileSync(outputPath, JSON.stringify({
      keyword: searchKeyword,
      count: posts.length,
      lastUpdated: new Date().toISOString(),
      posts: posts
    }, null, 2));
    
    console.log(`스크래핑이 완료되었습니다. 결과는 ${outputPath} 파일에 저장되었습니다.`);
    
    // 임시 파일 삭제
    if (fs.existsSync(tempOutputPath)) {
      fs.unlinkSync(tempOutputPath);
      console.log(`임시 파일 ${tempOutputPath}이 삭제되었습니다.`);
    }
    
    // 브라우저 종료
    await browser.close();
    
    return posts;
  } catch (error) {
    console.error('스크래핑 중 오류가 발생했습니다:', error);
    
    // 오류가 발생해도 중간 결과 저장
    if (posts.length > 0) {
      fs.writeFileSync(tempOutputPath, JSON.stringify({
        keyword: searchKeyword,
        count: posts.length,
        lastUpdated: new Date().toISOString(),
        error: error.message,
        posts: posts
      }, null, 2));
      console.log(`오류가 발생했지만 중간 결과는 ${tempOutputPath}에 저장되었습니다.`);
    }
    
    await browser.close();
    throw error;
  }
}

// 실행 부분
const searchKeyword = '부모님 휴대폰'; // 검색할 키워드 설정
const maxPostsToCollect = 1000; // 최대 수집할 게시물 수 설정

// 설정 객체 생성
const crawlerConfig = {
  keyword: searchKeyword,
  maxPosts: maxPostsToCollect,
  saveComments: true, // 댓글도 함께 수집할지 여부
  timeout: 20 * 60 * 1000 // 크롤링 최대 실행 시간 (20분)
};

// 결과 요약 함수
function generateSummary(posts) {
  // 날짜 기준으로 그룹화
  const postsByDate = {};
  let totalComments = 0;
  let postsWithComments = 0;
  let totalLikes = 0;
  let totalViews = 0;
  
  posts.forEach(post => {
    // 날짜 추출 (YYYY-MM 형식으로)
    let dateKey = '날짜 없음';
    if (post.date) {
      const dateParts = post.date.split('.');
      if (dateParts.length >= 2) {
        dateKey = `${dateParts[0]}-${dateParts[1].padStart(2, '0')}`;
      }
    }
    
    if (!postsByDate[dateKey]) {
      postsByDate[dateKey] = 0;
    }
    postsByDate[dateKey]++;
    
    // 댓글 통계
    const commentCount = post.comments ? post.comments.length : 0;
    totalComments += commentCount;
    if (commentCount > 0) {
      postsWithComments++;
    }
    
    // 좋아요 및 조회수
    totalLikes += post.likes || 0;
    totalViews += post.views || 0;
  });
  
  // 결과 표시
  console.log('\n===== 크롤링 결과 요약 =====');
  console.log(`총 수집된 게시물: ${posts.length}개`);
  console.log(`총 댓글 수: ${totalComments}개`);
  console.log(`댓글이 있는 게시물: ${postsWithComments}개 (${Math.round(postsWithComments/posts.length*100)}%)`);
  console.log(`평균 댓글 수: ${(totalComments / posts.length).toFixed(1)}개/게시물`);
  console.log(`총 좋아요 수: ${totalLikes}개 (평균: ${(totalLikes / posts.length).toFixed(1)}개/게시물)`);
  console.log(`총 조회수: ${totalViews}회 (평균: ${(totalViews / posts.length).toFixed(1)}회/게시물)`);
  
  console.log('\n기간별 게시물 수:');
  // 날짜순 정렬
  const sortedDates = Object.keys(postsByDate).sort();
  sortedDates.forEach(date => {
    console.log(`${date}: ${postsByDate[date]}개`);
  });
  console.log('===========================\n');
}

scrapeTeamblind(crawlerConfig)
  .then((posts) => {
    console.log('스크래핑 프로세스가 성공적으로 완료되었습니다.');
    generateSummary(posts);
  })
  .catch(err => console.error('스크래핑 중 오류가 발생했습니다:', err));